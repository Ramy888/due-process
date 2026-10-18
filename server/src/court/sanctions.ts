// After the ruling: the human appeals judge approves or declines the sanctions. Approved sanctions become one
// human-signed JUDGMENT per defendant, written by the Desk Writer workflow; DeskLedger slashes the bond, suspends the
// licence or revokes the Chief's auto-approve rule. The case trail's head at approval is the on-chain caseHash.
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { ApprovalQueue } from "../approvals.js";
import type { Trail } from "../agents/trail.js";
import { emit } from "../bus.js";
import type { WriteDesk } from "../ledger/desk-writer.js";
import { deskDomain, signJudgment, type JudgmentMessage } from "../ledger/eip712.js";
import { CHIEF } from "./exhibits.js";
import type { CaseFile, JudgeAnswer } from "./court.js";

// DeskLedger sanction bits
export const SLASH_BOND = 1;
export const SUSPEND_LICENCE = 2;
export const REVOKE_AUTO_APPROVE = 4;

export type SanctionRequest = { caseTrailId: string; summary: string; sanctions: JudgeAnswer["sanctions"] };

export type SanctionDeps = {
  approvals: ApprovalQueue<SanctionRequest>;
  human: LocalAccount;
  domain: ReturnType<typeof deskDomain>;
  writeDesk: WriteDesk;
  addressOf: (defendant: string) => Address;
};

export type Enforcement = {
  approved: boolean;
  caseHash: Hex;
  judgments: { defendant: string; caseId: Hex; sanctions: number; slashUsd: number; txHash: Hex | null }[];
  revokedAutoApprove: boolean;
};

export const sanctionBits = (s: JudgeAnswer["sanctions"][number]) =>
  (s.slashUsd > 0 ? SLASH_BOND : 0) | (s.suspendLicence ? SUSPEND_LICENCE : 0) | (s.revokeAutoApprove ? REVOKE_AUTO_APPROVE : 0);

export async function enforceSanctions(deps: SanctionDeps, file: CaseFile, trail: Trail): Promise<Enforcement> {
  const sanctions = file.ruling.sanctions;
  if (sanctions.length === 0) {
    trail.append("desk", "case.closed", { why: "no sanctions" });
    return { approved: false, caseHash: trail.head(), judgments: [], revokedAutoApprove: false };
  }
  const approved = await deps.approvals.request({ caseTrailId: file.trailId, summary: file.ruling.summary, sanctions });
  trail.append("Human appeals judge", approved ? "sanctions.approved" : "sanctions.declined", { sanctions });
  const caseHash = trail.head();
  if (!approved) return { approved, caseHash, judgments: [], revokedAutoApprove: false };

  const judgments: Enforcement["judgments"] = [];
  for (const s of sanctions) {
    const message: JudgmentMessage = {
      caseId: keccak256(stringToBytes(`${file.trailId}:${s.defendant}`)),
      defendant: deps.addressOf(s.defendant),
      sanctions: sanctionBits(s),
      slashAmount: BigInt(Math.round(s.slashUsd * 1e6)),
      caseHash,
    };
    const humanSig = await signJudgment(deps.human, deps.domain, message);
    const written = await deps.writeDesk({
      kind: "judgment",
      judgment: {
        caseId: message.caseId,
        defendant: message.defendant,
        sanctions: message.sanctions,
        slashAmountE6: message.slashAmount.toString(),
        caseHash,
      },
      humanSig,
    });
    trail.append("desk-writer", "ledger.judgment", { defendant: s.defendant, caseId: message.caseId, sanctions: message.sanctions, txHash: written.txHash, mode: written.mode, log: written.log });
    emit({ type: "ledger.write", beatId: "court", ...written });
    judgments.push({ defendant: s.defendant, caseId: message.caseId, sanctions: message.sanctions, slashUsd: s.slashUsd, txHash: written.txHash });
  }
  return { approved, caseHash, judgments, revokedAutoApprove: sanctions.some((s) => s.revokeAutoApprove && s.defendant === CHIEF) };
}
