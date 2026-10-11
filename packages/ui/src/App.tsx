import type { RunsResponse } from "../server/api";
import type { RunView } from "../server/model";
import { AppHeader } from "./components/AppHeader";
import { useJson, useVersion } from "./live";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { useRoute, type Route } from "./router";

const runUrl = (route: Extract<Route, { page: "run" }>): string => {
  const q = new URLSearchParams();
  if (route.attempt !== undefined) q.set("attempt", String(route.attempt));
  if (route.scope !== undefined) q.set("scope", route.scope);
  const query = q.toString();
  return `/api/runs/${encodeURIComponent(route.issue)}${query !== "" ? `?${query}` : ""}`;
};

const RunScreen = ({ route }: { route: Extract<Route, { page: "run" }> }) => {
  const run = useJson<RunView>(runUrl(route), useVersion(route.issue));
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
