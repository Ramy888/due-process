// One agent loop for every role: a frozen role prompt, the case state as JSON input, and a typed JSON answer.
// Answers come from the replay cache when present; `replay` mode never calls the model (the video must not go live).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { canonicalJson } from "./canonical.js";
import { ReplayCache, replayKey } from "./replay.js";
import { ROOT, anthropicKey } from "../env.js";

export const MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high";
export type AgentMode = "replay" | "live" | "cache-first";

export type AgentTask<S extends z.ZodType> = {
  role: string;
  /** Frozen per role: no timestamps or ids, so it caches and replays. */
  system: string;
  input: unknown;
  schema: S;
  effort: Effort;
};

/** Calls a model and returns the raw JSON answer. Swapped for a fake in tests. */
export type ModelFn = (task: AgentTask<z.ZodType>) => Promise<unknown>;

export type AgentResult<T> = { output: T; key: string; source: "cache" | "model" };

export class RefusalError extends Error {}

export function claudeModel(apiKey: string): ModelFn {
  const client = new Anthropic({ apiKey });
  return async (task) => {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: task.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: canonicalJson(task.input) }],
      output_config: { effort: task.effort, format: betaZodOutputFormat(task.schema) },
    });
    if (response.stop_reason === "refusal") {
      throw new RefusalError(`${task.role}: model declined (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error(`${task.role}: answer cut off at max_tokens`);
    if (response.parsed_output == null) throw new Error(`${task.role}: answer did not match its schema`);
    return response.parsed_output;
  };
}

export class AgentRuntime {
  constructor(
    private readonly model: ModelFn,
    private readonly cache: ReplayCache,
    readonly mode: AgentMode,
  ) {}

  async run<S extends z.ZodType>(task: AgentTask<S>): Promise<AgentResult<z.infer<S>>> {
    const key = replayKey({ model: MODEL, role: task.role, system: task.system, schema: z.toJSONSchema(task.schema), input: task.input });
    const hit = this.mode === "live" ? undefined : this.cache.get(key);
    if (hit) return { output: task.schema.parse(hit.output), key, source: "cache" };
    if (this.mode === "replay") throw new Error(`replay mode: no recorded answer for ${task.role} (${key.slice(0, 12)})`);

    const output = task.schema.parse(await this.model(task));
    this.cache.put({ key, role: task.role, model: MODEL, input: task.input, output });
    return { output, key, source: "model" };
  }
}

export const agentModeFromEnv = (): AgentMode => {
  const m = process.env.AGENT_MODE ?? "cache-first";
  if (m !== "replay" && m !== "live" && m !== "cache-first") throw new Error(`AGENT_MODE must be replay, live or cache-first`);
  return m;
};

/** The desk's runtime: committed replay file, AGENT_MODE, and the Anthropic key read only when a model call is needed. */
export function runtimeFromEnv(): AgentRuntime {
  let model: ModelFn | undefined;
  const lazyClaude: ModelFn = (task) => (model ??= claudeModel(anthropicKey()))(task);
  const file = process.env.AGENT_REPLAY_FILE ?? `${ROOT}data/replay/agents.jsonl`;
  return new AgentRuntime(lazyClaude, new ReplayCache(file), agentModeFromEnv());
}
