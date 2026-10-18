import { useState } from "react";
import { Agents } from "./components/Agents";
import { Approvals } from "./components/Approvals";
import { Court } from "./components/Court";
import { Floor } from "./components/Floor";
import { Header } from "./components/Header";
import { Market } from "./components/Market";
import { deskPost, useDeskFloor, useDeskState } from "./desk";

export function App() {
  const state = useDeskState();
  const floor = useDeskFloor();
  const [error, setError] = useState<string | null>(null);
  const running = state?.run.status === "running";

  const run = async () => {
    setError(null);
    const r = await deskPost("/scenario/run", { scenarioId: "frog-day" });
    if (!r.ok) setError((await r.json()).error ?? `HTTP ${r.status}`);
  };

  return (
    <div className="min-h-screen font-sans">
      <Header state={state} />
      {state && <Approvals state={state} />}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={!state || running}
            className="rounded-lg bg-court px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-court/90 disabled:opacity-50"
          >
            {running ? "Scenario running…" : "Run the Frog Day scenario"}
          </button>
          <span className="text-sm text-stone-600">
            {state?.run.status === "failed" && <span className="text-rose-700">Run failed: {state.run.error}</span>}
            {state?.run.status === "finished" && "Run finished."}
            {state?.run.runId && <span className="ml-2 font-mono text-xs text-stone-400">{state.run.runId}</span>}
          </span>
          {error && <span className="text-sm text-rose-700">{error}</span>}
        </div>
        {!state ? (
          <p className="text-sm text-stone-600">Connecting to the desk server…</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="min-w-0 space-y-6 lg:col-span-2">
              <Floor beats={floor.beats} state={state} />
              <Court court={floor.court} runId={floor.runId} />
            </div>
            <div className="min-w-0 space-y-6">
              <Market state={state} />
              <Agents state={state} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
