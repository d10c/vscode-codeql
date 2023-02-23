import {
  CancellationTokenSource,
  ExtensionContext,
  Uri,
  ViewColumn,
  window,
  workspace,
} from "vscode";
import { AbstractWebview, WebviewPanelConfig } from "../abstract-webview";
import {
  FromExternalApiMessage,
  ToExternalApiMessage,
} from "../pure/interface-types";
import { qlpackOfDatabase } from "../contextual/queryResolver";
import { CodeQLCliServer } from "../cli";
import { file } from "tmp-promise";
import { writeFile } from "fs-extra";
import { dump } from "js-yaml";
import { getOnDiskWorkspaceFolders } from "../helpers";
import { extLogger, TeeLogger } from "../common";
import { DatabaseItem, DatabaseManager } from "../local-databases";
import { CoreCompletedQuery, QueryRunner } from "../queryRunner";
import { assertNever, getErrorMessage } from "../pure/helpers-pure";
import { ResolvableLocationValue } from "../pure/bqrs-cli-types";
import { showResolvableLocation } from "../interface-utils";
import { App } from "../common/app";
import { promptImportGithubDatabase } from "../databaseFetcher";
import { promisify } from "util";
import * as child_process from "child_process";
import { ProgressUpdate } from "../progress";

export class ExternalApiView extends AbstractWebview<
  ToExternalApiMessage,
  FromExternalApiMessage
> {
  public constructor(
    ctx: ExtensionContext,
    private readonly app: App,
    private readonly databaseManager: DatabaseManager,
    private readonly cliServer: CodeQLCliServer,
    private readonly queryRunner: QueryRunner,
    private readonly queryStorageDir: string,
    private readonly databaseItem: DatabaseItem,
  ) {
    super(ctx);
  }

  public async openView() {
    const panel = await this.getPanel();
    panel.reveal(undefined, true);

    await this.waitForPanelLoaded();
  }

  protected async getPanelConfig(): Promise<WebviewPanelConfig> {
    return {
      viewId: "external-api-view",
      title: "External API usage",
      viewColumn: ViewColumn.Active,
      preserveFocus: true,
      view: "external-api",
    };
  }

  protected onPanelDispose(): void {
    // Nothing to do here
  }

  protected async onMessage(msg: FromExternalApiMessage): Promise<void> {
    switch (msg.t) {
      case "viewLoaded":
        await this.onWebViewLoaded();

        break;
      case "applyDataExtensionYaml":
        await this.saveYaml(msg.yaml);
        await this.loadExternalApiUsages();

        break;
      case "jumpToUsage":
        await this.jumpToUsage(msg.location);

        break;
      case "generateExternalApi":
        await this.generateExternalApi();
        await this.loadExternalApiUsages();

        break;
      default:
        assertNever(msg);
    }
  }

  protected async onWebViewLoaded() {
    super.onWebViewLoaded();

    await this.loadExternalApiUsages();
  }

  protected async jumpToUsage(
    location: ResolvableLocationValue,
  ): Promise<void> {
    try {
      await showResolvableLocation(location, this.databaseItem);
    } catch (e) {
      if (e instanceof Error) {
        if (e.message.match(/File not found/)) {
          void window.showErrorMessage(
            "Original file of this result is not in the database's source archive.",
          );
        } else {
          void extLogger.log(`Unable to handleMsgFromView: ${e.message}`);
        }
      } else {
        void extLogger.log(`Unable to handleMsgFromView: ${e}`);
      }
    }
  }

  protected async generateExternalApi(): Promise<void> {
    const tokenSource = new CancellationTokenSource();

    const database = await promptImportGithubDatabase(
      this.app.commands,
      this.databaseManager,
      this.app.workspaceStoragePath ?? this.app.globalStoragePath,
      this.app.credentials,
      (update) => this.showProgress(update),
      tokenSource.token,
      this.cliServer,
    );
    if (!database) {
      await this.clearProgress();
      void extLogger.log("No database chosen");

      return;
    }

    const workspaceFolder = workspace.workspaceFolders?.find(
      (folder) => folder.name === "ql",
    );
    if (!workspaceFolder) {
      void extLogger.log("No workspace folder 'ql' found");

      return;
    }

    await this.showProgress({
      step: 1,
      maxStep: 4,
      message: "Generating external API",
    });

    const base = "python3";
    const args = [
      Uri.joinPath(
        workspaceFolder.uri,
        "java/ql/src/utils/modelgenerator/GenerateFlowModel.py",
      ).fsPath,
      database.databaseUri.fsPath,
      database.name.replaceAll("/", "."),
    ];

    void extLogger.log(`Running ${base} ${args.join(" ")}`);

    try {
      const result = await promisify(child_process.execFile)(base, args, {
        cwd: workspaceFolder.uri.fsPath,
      });
      void extLogger.log(`stdout: ${result.stdout}`);
      void extLogger.log(`stdout: ${result.stderr}`);
    } catch (e: unknown) {
      void extLogger.log(`Error: ${getErrorMessage(e)}`);
    }

    await this.clearProgress();
  }

  protected async loadExternalApiUsages(): Promise<void> {
    const queryResult = await this.runQuery();
    if (!queryResult) {
      await this.clearProgress();
      return;
    }

    await this.showProgress({
      message: "Loading results",
      step: 1100,
      maxStep: 1500,
    });

    void extLogger.log(`Query result: ${JSON.stringify(queryResult)}`);

    const bqrsPath = queryResult.outputDir.bqrsPath;

    void extLogger.log(`BQRS path: ${bqrsPath}`);

    const results = await this.getResults(bqrsPath);
    if (!results) {
      await this.clearProgress();
      return;
    }

    await this.showProgress({
      message: "Finalizing results",
      step: 1450,
      maxStep: 1500,
    });

    void extLogger.log(`Results: ${JSON.stringify(results)}`);

    await this.postMessage({
      t: "setExternalApiRepoResults",
      results,
    });

    await this.clearProgress();
  }

  protected async saveYaml(yaml: string): Promise<void> {
    void extLogger.log(`Saving data extension YAML: ${yaml}`);

    const workspaceFolder = workspace.workspaceFolders?.find(
      (folder) => folder.name === "ql",
    );
    if (!workspaceFolder) {
      void extLogger.log("No workspace folder 'ql' found");

      return;
    }

    const path = Uri.joinPath(
      workspaceFolder.uri,
      "java/ql/lib/ext/vscode.model.yml",
    ).fsPath;

    await writeFile(path, yaml);

    void extLogger.log(`Saved data extension YAML to ${path}`);
  }

  private async runQuery(): Promise<CoreCompletedQuery | undefined> {
    const qlpacks = await qlpackOfDatabase(this.cliServer, this.databaseItem);

    const packsToSearch = [qlpacks.dbschemePack];
    if (qlpacks.queryPack) {
      packsToSearch.push(qlpacks.queryPack);
    }

    const suiteFile = (
      await file({
        postfix: ".qls",
      })
    ).path;
    const suiteYaml = [];
    for (const qlpack of packsToSearch) {
      suiteYaml.push({
        from: qlpack,
        queries: ".",
        include: {
          id: `${this.databaseItem.language}/telemetry/fetch-external-apis`,
        },
      });
    }
    await writeFile(suiteFile, dump(suiteYaml), "utf8");

    const queries = await this.cliServer.resolveQueriesInSuite(
      suiteFile,
      getOnDiskWorkspaceFolders(),
    );

    if (queries.length !== 1) {
      void extLogger.log(`Expected exactly one query, got ${queries.length}`);
      return;
    }

    const query = queries[0];

    const tokenSource = new CancellationTokenSource();

    const queryRun = this.queryRunner.createQueryRun(
      this.databaseItem.databaseUri.fsPath,
      { queryPath: query, quickEvalPosition: undefined },
      false,
      getOnDiskWorkspaceFolders(),
      undefined,
      this.queryStorageDir,
      undefined,
      undefined,
    );

    return queryRun.evaluate(
      (update) => this.showProgress(update, 1500),
      tokenSource.token,
      new TeeLogger(this.queryRunner.logger, queryRun.outputDir.logPath),
    );
  }

  private async getResults(bqrsPath: string) {
    const bqrsInfo = await this.cliServer.bqrsInfo(bqrsPath);
    if (bqrsInfo["result-sets"].length !== 1) {
      void extLogger.log(
        `Expected exactly one result set, got ${bqrsInfo["result-sets"].length}`,
      );
      return undefined;
    }

    const resultSet = bqrsInfo["result-sets"][0];

    await this.showProgress({
      message: "Decoding results",
      step: 1200,
      maxStep: 1500,
    });

    return this.cliServer.bqrsDecode(bqrsPath, resultSet.name);
  }

  private async showProgress(update: ProgressUpdate, maxStep?: number) {
    await this.postMessage({
      t: "showProgress",
      step: update.step,
      maxStep: maxStep ?? update.maxStep,
      message: update.message,
    });
  }

  private async clearProgress() {
    await this.showProgress({
      step: 0,
      maxStep: 0,
      message: "",
    });
  }
}
