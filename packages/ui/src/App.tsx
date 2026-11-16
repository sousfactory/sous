import type { RunsResponse } from "../server/api";
import type { RunView } from "../server/model";
import { AppHeader } from "./components/AppHeader";
import { useJson, useVersion } from "./live";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { runApi, useRoute, type Route } from "./router";

const runUrl = (route: Extract<Route, { page: "run" }>): string =>
  runApi(route.issue, route.repo, "", {
    ...(route.attempt !== undefined ? { attempt: String(route.attempt) } : {}),
    ...(route.scope !== undefined ? { scope: route.scope } : {}),
  });

const RunScreen = ({ route }: { route: Extract<Route, { page: "run" }> }) => {
  const run = useJson<RunView>(runUrl(route), useVersion(route.issue, route.repo));
  return <RunPage route={route} view={run.data?.summary.issue === route.issue ? run.data : undefined} error={run.error} />;
};

export const App = () => {
  const route = useRoute();
  const runs = useJson<RunsResponse>("/api/runs", useVersion());
  return (
    <>
      <AppHeader repo={runs.data?.repo ?? "…"} live={(runs.data?.live.length ?? 0) > 0} />
      {route.page === "runs" ? <RunsPage data={runs.data} error={runs.error} flow={route.flow} step={route.step} /> : <RunScreen route={route} />}
    </>
  );
};
