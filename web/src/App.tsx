import { useEffect, useRef, useState } from "react";
import { Court } from "./components/Court";
import { DeskMap } from "./components/DeskMap";
import { Floor } from "./components/Floor";
import { Header } from "./components/Header";
import { deskPost, useDeskFloor, useDeskState } from "./desk";

export function App() {
  const state = useDeskState();
  const floor = useDeskFloor();
  const [error, setError] = useState<string | null>(null);
  const courtRef = useRef<HTMLDivElement>(null);
  const running = state?.run.status === "running";
  const courtLive = floor.court.alerts.length > 0;

  const run = async () => {
    setError(null);
    const r = await deskPost("/scenario/run", { scenarioId: "frog-day" });
    if (!r.ok) setError((await r.json()).error ?? `HTTP ${r.status}`);
  };
  const toCourt = () => requestAnimationFrame(() => courtRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

  // When surveillance opens a case during a live run, bring the court into view. Not on a reload of a finished run:
  // the event stream replays its buffer on connect, so the court appearing is not by itself news.
  const wasLive = useRef(courtLive);
  useEffect(() => {
    if (courtLive && !wasLive.current && running) toCourt();
    wasLive.current = courtLive;
  }, [courtLive, running]);

  return (
    <div className="min-h-screen font-sans">
      {/* the first screen: the desk map and the trades panel side by side, filling the window on a laptop */}
      <div className="flex flex-col lg:h-dvh lg:min-h-[600px]">
        <Header state={state} onRun={run} error={error} />
        {!state ? (
          <p className="mx-auto w-full max-w-[1500px] px-4 py-6 text-sm text-stone-600">Connecting to the desk server…</p>
        ) : (
          <main className="mx-auto grid w-full max-w-[1500px] gap-4 px-4 py-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_440px]">
            <DeskMap state={state} floor={floor} onCourt={toCourt} />
            <Floor beats={floor.beats} state={state} follow={running} />
          </main>
        )}
      </div>
      {state && (
        <div ref={courtRef} className="mx-auto w-full max-w-[1500px] scroll-mt-2 px-4">
          <Court court={floor.court} runId={floor.runId} state={state} />
        </div>
      )}
    </div>
  );
}
