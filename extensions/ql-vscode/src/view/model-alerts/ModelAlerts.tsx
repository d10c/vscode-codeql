import { useCallback, useEffect, useMemo, useState } from "react";
import { styled } from "styled-components";
import { ModelAlertsHeader } from "./ModelAlertsHeader";
import type { ModelAlertsViewState } from "../../model-editor/shared/view-state";
import type { ToModelAlertsMessage } from "../../common/interface-types";
import type {
  VariantAnalysis,
  VariantAnalysisScannedRepositoryResult,
} from "../../variant-analysis/shared/variant-analysis";
import { vscode } from "../vscode-api";
import { ModelAlertsResults } from "./ModelAlertsResults";
import type { ModelAlerts } from "../../model-editor/model-alerts/model-alerts";
import { calculateModelAlerts } from "../../model-editor/model-alerts/alert-processor";

type Props = {
  initialViewState?: ModelAlertsViewState;
  variantAnalysis?: VariantAnalysis;
  repoResults?: VariantAnalysisScannedRepositoryResult[];
};

const SectionTitle = styled.h3`
  font-size: medium;
  font-weight: 500;
  margin: 0;
  padding-bottom: 10px;
`;

export function ModelAlerts({
  initialViewState,
  variantAnalysis: initialVariantAnalysis,
  repoResults: initialRepoResults = [],
}: Props): React.JSX.Element {
  const onOpenModelPackClick = useCallback((path: string) => {
    vscode.postMessage({
      t: "openModelPack",
      path,
    });
  }, []);

  const onStopRunClick = useCallback(() => {
    vscode.postMessage({
      t: "stopEvaluationRun",
    });
  }, []);

  const [viewState, setViewState] = useState<ModelAlertsViewState | undefined>(
    initialViewState,
  );

  const [variantAnalysis, setVariantAnalysis] = useState<
    VariantAnalysis | undefined
  >(initialVariantAnalysis);
  const [repoResults, setRepoResults] =
    useState<VariantAnalysisScannedRepositoryResult[]>(initialRepoResults);

  useEffect(() => {
    const listener = (evt: MessageEvent) => {
      if (evt.origin === window.origin) {
        const msg: ToModelAlertsMessage = evt.data;
        switch (msg.t) {
          case "setModelAlertsViewState": {
            setViewState(msg.viewState);
            break;
          }
          case "setVariantAnalysis": {
            setVariantAnalysis(msg.variantAnalysis);
            break;
          }
          case "setReposResults": {
            setRepoResults(msg.reposResults);
            break;
          }
          case "setRepoResults": {
            setRepoResults((oldRepoResults) => {
              const newRepoIds = msg.repoResults.map((r) => r.repositoryId);
              return [
                ...oldRepoResults.filter(
                  (v) => !newRepoIds.includes(v.repositoryId),
                ),
                ...msg.repoResults,
              ];
            });
            break;
          }
        }
      } else {
        // sanitize origin
        const origin = evt.origin.replace(/\n|\r/g, "");
        console.error(`Invalid event origin ${origin}`);
      }
    };
    window.addEventListener("message", listener);

    return () => {
      window.removeEventListener("message", listener);
    };
  }, []);

  const modelAlerts = useMemo(() => {
    if (!repoResults) {
      return [];
    }

    const alerts = repoResults.flatMap((a) => a.interpretedResults ?? []);

    return calculateModelAlerts(alerts);
  }, [repoResults]);

  if (viewState === undefined || variantAnalysis === undefined) {
    return <></>;
  }

  const openLogs = () => {
    vscode.postMessage({
      t: "openActionsLogs",
      variantAnalysisId: variantAnalysis.id,
    });
  };

  const onViewLogsClick =
    variantAnalysis.actionsWorkflowRunId === undefined ? undefined : openLogs;

  return (
    <>
      <ModelAlertsHeader
        viewState={viewState}
        variantAnalysis={variantAnalysis}
        openModelPackClick={onOpenModelPackClick}
        onViewLogsClick={onViewLogsClick}
        stopRunClick={onStopRunClick}
      ></ModelAlertsHeader>
      <div>
        <SectionTitle>Model alerts</SectionTitle>
        <div>
          {modelAlerts.map((alerts, i) => (
            // We're using the index as the key here which is not recommended.
            // but we don't have a unique identifier for models. In the future,
            // we may need to consider coming up with unique identifiers for models
            // and using those as keys.
            <ModelAlertsResults key={i} modelAlerts={alerts} />
          ))}
        </div>
      </div>
    </>
  );
}
