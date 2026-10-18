import { useState } from "react";
import { Agents } from "./components/Agents";
import { Approvals } from "./components/Approvals";
import { Court } from "./components/Court";
import { DeskMap } from "./components/DeskMap";
import { Floor } from "./components/Floor";
import { Header } from "./components/Header";
import { Market } from "./components/Market";
import { deskPost, useDeskFloor, useDeskState } from "./desk";

export function App() {
  const state = useDeskState();
  const floor = useDeskFloor();
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    const r = await deskPost("/scenario/run", { scenarioId: "frog-day" });
    if (!r.ok) setError((await r.json()).error ?? `HTTP ${r.status}`);
  };

  return (
    <div className="min-h-screen font-sans">
      <Header state={state} onRun={run} error={error} />
      {state && <Approvals state={state} />}
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-6">
        {!state ? (
          <p className="text-sm text-stone-600">Connecting to the desk server…</p>
        ) : (
          <>
            <DeskMap state={state} floor={floor} />
            <Market state={state} />
            <Agents state={state} />
            <section>
              <h2 className="mb-3 font-serif text-xl font-semibold text-court">Trades</h2>
              <Floor beats={floor.beats} state={state} />
            </section>
            <Court court={floor.court} runId={floor.runId} state={state} />
          </>
        )}
      </main>
    </div>
  );
}
