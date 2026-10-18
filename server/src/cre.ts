// Runs CRE workflows through the CLI simulator (the "pay → cre workflow simulate" gateway pattern; no DON deploy).
// One run at a time (the CLI compiles into a shared temp file per workflow), every log line streamed to the caller,
// and the full log kept under proof/runs/ as evidence.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { ROOT } from "./env.js";

export type Workflow = "clearance" | "desk-writer";

export type CreRunOptions = {
  workflow: Workflow;
  payload: unknown;
  /** CRE target in workflow.yaml; `local-simulation` needs no deployed ledger. */
  target: string;
  /** Send the report transactions for real (signed by CRE_ETH_PRIVATE_KEY in workflows/.env). */
  broadcast: boolean;
  onLine?: (line: string) => void;
};

export type CreRun = { runId: string; result: unknown; logPath: string };

export type CreRunnerConfig = { bin: string; workflowsDir: string; logsDir: string; timeoutMs: number };

export const defaultCreConfig = (): CreRunnerConfig => ({
  bin: process.env.CRE_BIN ?? "cre",
  workflowsDir: `${ROOT}workflows`,
  logsDir: `${ROOT}proof/runs`,
  timeoutMs: Number(process.env.CRE_TIMEOUT_MS ?? 180_000),
});

export class CreRunError extends Error {
  constructor(message: string, readonly logPath: string) {
    super(message);
  }
}

/** The workflow's return value. The CLI prints it JSON-encoded, so a returned JSON string is decoded twice. */
export function parseSimulationResult(log: string): unknown {
  const marker = "Workflow Simulation Result:";
  const at = log.lastIndexOf(marker);
  if (at < 0) return undefined;
  const line = log
    .slice(at + marker.length)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  const outer = JSON.parse(line);
  return typeof outer === "string" ? JSON.parse(outer) : outer;
}

let queue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
};

export function runCre(opts: CreRunOptions, config: CreRunnerConfig = defaultCreConfig()): Promise<CreRun> {
  return oneAtATime(() => runOnce(opts, config));
}

async function runOnce(opts: CreRunOptions, config: CreRunnerConfig): Promise<CreRun> {
  const runId = randomUUID();
  // The CLI only accepts payload files inside the CRE project.
  const payloadRel = `payloads/runtime/${runId}.json`;
  const payloadPath = `${config.workflowsDir}/${payloadRel}`;
  mkdirSync(`${config.workflowsDir}/payloads/runtime`, { recursive: true });
  mkdirSync(config.logsDir, { recursive: true });
  const logPath = `${config.logsDir}/${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.workflow}-${runId.slice(0, 8)}.log`;
  const args = ["workflow", "simulate", opts.workflow, "--target", opts.target, "--non-interactive", "--trigger-index", "0", "--http-payload", payloadRel];
  if (opts.broadcast) args.push("--broadcast");

  writeFileSync(payloadPath, JSON.stringify(opts.payload));
  let log = "";
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(config.bin, args, {
        cwd: config.workflowsDir,
        env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH ?? ""}` },
        timeout: config.timeoutMs,
      });
      let pending = "";
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        log += text;
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) opts.onLine?.(line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("close", (code) => {
        if (pending.trim()) opts.onLine?.(pending);
        resolve(code);
      });
    });
    const result = parseSimulationResult(log);
    if (exitCode !== 0 || result === undefined) {
      const tail = log.trim().split("\n").slice(-5).join("\n");
      throw new CreRunError(`cre ${opts.workflow} failed (exit ${exitCode}):\n${tail}`, logPath);
    }
    return { runId, result, logPath };
  } finally {
    writeFileSync(logPath, log);
    rmSync(payloadPath, { force: true });
  }
}
