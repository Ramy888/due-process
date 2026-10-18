// The AI court: Surveillance refers the case, the Prosecutor charges, each defendant's Defense answers from the
// defendant's own words on the trail, and the Judge rules. Every citation must come from data/law/references.json
// and every piece of evidence must be an exhibit id; answers that stray are rejected before they are cached.
import { z } from "zod/v4";
import type { MandatePolicy } from "../agents/mandate.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { Trail } from "../agents/trail.js";
import { DESK } from "../desk.js";
import type { DeskStore } from "../store.js";
import type { TraderKey } from "../traders.js";
import { buildExhibits, CHIEF, forCourt, lawLibrary, type Exhibit, type MarketPrices } from "./exhibits.js";
import type { Alert } from "./surveillance.js";

const PREAMBLE = `This is a simulated proceeding on the Due Process desk, where AI trading agents make practice trades with
paper money. The defendants are AI agents; real-world rules apply to them by analogy only. Write for a reader with no
legal or trading background: short plain sentences. Refer to evidence only by exhibit id (for example "E3") and cite
only authorities from the library you are given, by their id.`;

const referralAnswer = z.object({ memo: z.string(), defendants: z.array(z.string()) });
const chargeSheet = z.object({
  charges: z.array(z.object({ defendant: z.string(), count: z.string(), allegation: z.string(), citations: z.array(z.string()), exhibits: z.array(z.string()) })),
});
const defenseAnswer = z.object({
  responses: z.array(z.object({ count: z.string(), plea: z.enum(["contest", "admit", "mitigate"]), argument: z.string() })),
  mitigation: z.string(),
});
const judgeAnswer = z.object({
  rulings: z.array(
    z.object({ defendant: z.string(), count: z.string(), guilty: z.boolean(), reasoning: z.string(), citations: z.array(z.string()), exhibits: z.array(z.string()) }),
  ),
  sanctions: z.array(z.object({ defendant: z.string(), slashUsd: z.number(), suspendLicence: z.boolean(), revokeAutoApprove: z.boolean(), rationale: z.string() })),
  summary: z.string(),
});
export type ChargeSheet = z.infer<typeof chargeSheet>;
export type DefenseAnswer = z.infer<typeof defenseAnswer>;
export type JudgeAnswer = z.infer<typeof judgeAnswer>;

export type CaseFile = {
  trailId: string;
  defendants: string[];
  alerts: Alert[];
  exhibits: Exhibit[];
  referral: z.infer<typeof referralAnswer>;
  charges: ChargeSheet["charges"];
  defenses: Record<string, DefenseAnswer>;
  ruling: JudgeAnswer;
};

export type CourtDeps = {
  runtime: AgentRuntime;
  store: DeskStore;
  policies: ReadonlyMap<TraderKey, MandatePolicy>;
  names: Readonly<Record<string, string>>;
  buyerName: (address: string) => string;
  market: MarketPrices;
};

const LAW_IDS = new Set(lawLibrary.map((l) => l.id));
const library = lawLibrary.map(({ id, title, summary }) => ({ id, title, summary }));

function checkRefs(where: string, citations: string[], exhibitIds: string[], known: Set<string>) {
  const badLaw = citations.filter((c) => !LAW_IDS.has(c));
  if (badLaw.length) throw new Error(`${where} cites authorities outside the library: ${badLaw.join(", ")}`);
  const badEx = exhibitIds.filter((e) => !known.has(e));
  if (badEx.length) throw new Error(`${where} refers to exhibits that do not exist: ${badEx.join(", ")}`);
}

/** The defendant's own words from this run's trails: trader reasoning and order notes, or the Chief's reviews. */
function statementsOf(store: DeskStore, runId: string, defendant: string): string[] {
  const entries = store.trailIds().filter((id) => id.startsWith(`${runId}:`)).flatMap((id) => store.trailEntries(id));
  const said: string[] = [];
  for (const e of entries) {
    const d = e.data as Record<string, any>;
    if (e.agent === defendant && e.kind === "trader.decision") said.push(d.decision?.reasoning);
    if (e.agent === defendant && e.kind === "trader.order") said.push(d.order?.note);
    if (defendant === CHIEF && e.kind === "chief.review") said.push(d.reason);
    if (defendant === CHIEF && e.kind === "chief.auto-approved") said.push(`Standing rule applied: ${d.rule}.`);
  }
  return [...new Set(said.filter(Boolean))];
}

export async function tryCase(deps: CourtDeps, runId: string, alerts: Alert[]): Promise<{ file: CaseFile; trail: Trail } | null> {
  if (alerts.length === 0) return null;
  const defendants = [...new Set(alerts.map((a) => deps.names[a.trader]))];
  if (alerts.some((a) => a.unreviewed)) defendants.push(CHIEF);
  const trailId = `${runId}:case`;
  const trail = deps.store.openTrail(trailId);
  const exhibits = buildExhibits(alerts, deps.policies, deps.buyerName, deps.market);
  const exhibitIds = new Set(exhibits.map((e) => e.id));
  const evidence = forCourt(exhibits);
  trail.append("surveillance", "case.opened", { defendants, alerts: alerts.map((a) => ({ code: a.code, detail: a.detail })), exhibits });

  const referral = await deps.runtime.run({
    role: "surveillance",
    system: `${PREAMBLE}\n\nYou are Surveillance. Write a short referral memo (at most 4 sentences) explaining to the prosecutor what the alerts show and who should answer for it. List the defendants exactly as given.`,
    input: { alerts: alerts.map((a) => ({ code: a.code, finding: a.detail, tradesReviewedByChiefBeforeRecording: !a.unreviewed })), defendants, exhibits: evidence },
    schema: referralAnswer,
    effort: "low",
    validate: (r) => {
      if ([...r.defendants].sort().join("|") !== [...defendants].sort().join("|")) throw new Error("Surveillance changed the list of defendants");
    },
  });
  trail.append("Surveillance", "case.referral", { ...referral.output, replayKey: referral.key });

  const charged = await deps.runtime.run({
    role: "prosecutor",
    system: `${PREAMBLE}\n\nYou are the Prosecutor. Draft the charge sheet: one or more counts per defendant. Each count names the conduct, cites the authorities it breaches (licence terms first, then regulations or rules by analogy), and lists the exhibits that prove it. Charge the Desk Chief only for its own conduct as supervisor.`,
    input: { defendants, referral: referral.output.memo, exhibits: evidence, library },
    schema: chargeSheet,
    effort: "medium",
    validate: (c) => {
      for (const d of defendants) if (!c.charges.some((x) => x.defendant === d)) throw new Error(`no charge against ${d}`);
      for (const x of c.charges) {
        if (!defendants.includes(x.defendant)) throw new Error(`charge against unknown defendant ${x.defendant}`);
        if (x.citations.length === 0 || x.exhibits.length === 0) throw new Error(`count "${x.count}" lacks citations or exhibits`);
        checkRefs(`count "${x.count}"`, x.citations, x.exhibits, exhibitIds);
      }
    },
  });
  const charges = charged.output.charges;
  trail.append("Prosecutor", "case.charges", { charges, replayKey: charged.key });

  const defenses: Record<string, DefenseAnswer> = {};
  for (const defendant of defendants) {
    const counts = charges.filter((c) => c.defendant === defendant);
    const answer = await deps.runtime.run({
      role: "defense",
      system: `${PREAMBLE}\n\nYou are Defense counsel for ${defendant}. Answer every count against your client, using your client's own recorded statements and the exhibits. Contest what the evidence does not prove, admit what it does, and argue mitigation honestly. Do not invent facts.`,
      input: { client: defendant, counts, clientStatements: statementsOf(deps.store, runId, defendant), exhibits: evidence },
      schema: defenseAnswer,
      effort: "medium",
      validate: (a) => {
        const answered = new Set(a.responses.map((r) => r.count));
        for (const c of counts) if (!answered.has(c.count)) throw new Error(`Defense for ${defendant} did not answer "${c.count}"`);
      },
    });
    defenses[defendant] = answer.output;
    trail.append(`Defense for ${defendant}`, "case.defense", { defendant, ...answer.output, replayKey: answer.key });
  }

  const ruled = await deps.runtime.run({
    role: "judge",
    system: `${PREAMBLE}\n\nYou are the Judge. Rule on every count (guilty or not), giving reasons that cite exhibits and authorities. Then set sanctions only for defendants found guilty of at least one count. The sanctions you may impose: slash part or all of a defendant's bond (each licensee posted $${DESK.bondUsd} of test USDC; slashUsd between 0 and ${DESK.bondUsd}), suspend a trader's licence, and, for the Desk Chief only, revoke its auto-approve rule for 24 hours so every trade needs the human's co-signature. A human appeals judge must approve your sanctions before they are recorded on-chain.`,
    input: { charges, defenses, exhibits: evidence, library, defendants },
    schema: judgeAnswer,
    effort: "high",
    validate: (j) => {
      for (const c of charges) {
        const r = j.rulings.filter((x) => x.defendant === c.defendant && x.count === c.count);
        if (r.length !== 1) throw new Error(`count "${c.count}" against ${c.defendant} needs exactly one ruling`);
      }
      for (const r of j.rulings) checkRefs(`ruling on "${r.count}"`, r.citations, r.exhibits, exhibitIds);
      for (const s of j.sanctions) {
        if (!j.rulings.some((r) => r.defendant === s.defendant && r.guilty)) throw new Error(`sanction against ${s.defendant}, who was not found guilty`);
        if (s.revokeAutoApprove && s.defendant !== CHIEF) throw new Error("only the Desk Chief's auto-approve rule can be revoked");
        if (!(s.slashUsd >= 0 && s.slashUsd <= DESK.bondUsd)) throw new Error(`slash of $${s.slashUsd} is outside 0..${DESK.bondUsd}`);
        if (s.slashUsd === 0 && !s.suspendLicence && !s.revokeAutoApprove) throw new Error(`empty sanction against ${s.defendant}`);
      }
    },
  });
  trail.append("Judge", "case.ruling", { ...ruled.output, replayKey: ruled.key });

  return { file: { trailId, defendants, alerts, exhibits, referral: referral.output, charges, defenses, ruling: ruled.output }, trail };
}
