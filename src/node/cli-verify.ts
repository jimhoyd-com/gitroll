// `gitroll verify`, `gitroll agent-key`, and what doctor says about signing.
// The checking itself is Git's; see signing.ts.
import type { GitRoll } from "./repo.ts";
import {
  ALLOWED_SIGNERS_PATH,
  agentPrincipal,
  agentsWithoutKeys,
  allowedSignersLine,
  checkAgentName,
  createAgentKey,
  readAllowedSigners,
  verifyCommits,
} from "./signing.ts";
import type { VerifiedCommit } from "./signing.ts";

type Paint = (s: string) => string;
export interface Colors { bold: Paint; dim: Paint; green: Paint; red: Paint; yellow: Paint }

/** What a signature status reads as, in the same words as the web app. */
export function signatureLabel(status: string | undefined): string {
  return status === "good" ? "Verified" : status === "bad" ? "Bad signature" : status === "unknown" ? "Unknown signer" : "Unsigned";
}

function describe(c: VerifiedCommit): string {
  if (c.agentCheck === "mismatch") return `says agent ${c.agent}, but was signed by ${c.signer}`;
  if (c.status === "good") return `signed by ${c.signer}${c.agentCheck === "match" ? " (matches its Gitroll-Agent trailer)" : ""}`;
  if (c.status === "bad") return "the signature doesn't match this commit";
  if (c.status === "unknown") return `signed by a key ${ALLOWED_SIGNERS_PATH} doesn't list${c.key ? ` (${c.key})` : ""}`;
  return c.agent ? `unsigned; its Gitroll-Agent: ${c.agent} trailer is only a claim` : "unsigned";
}

/** Exit 1 (with the report still printed) on a bad signature or an agent mismatch. */
export function runVerify(roll: GitRoll, opts: { since?: string; requireSigned?: boolean }, json: boolean, c: Colors): void {
  const report = verifyCommits(roll, opts);
  if (!report.ok) process.exitCode = 1;
  if (json) return console.log(JSON.stringify(report, null, 2));
  const s = report.summary;
  if (!s.total) return console.log(c.dim("No commits to check."));
  for (const commit of report.commits) {
    const failing = commit.status === "bad" || commit.agentCheck === "mismatch" || (report.requireSigned && commit.status !== "good");
    const mark = failing ? c.red("✗") : commit.status === "good" ? c.green("✓") : c.yellow("!");
    console.log(`${mark} ${commit.commit.slice(0, 12)} ${commit.date.slice(0, 10)} ${signatureLabel(commit.status).padEnd(14)} ${commit.subject}`);
    console.log(c.dim(`    ${describe(commit)}`));
  }
  console.log(
    `\n${s.total} ${s.total === 1 ? "change" : "changes"}${report.scope === "roll" ? " to .gitroll/" : ""}: ${s.good} verified, ${s.unsigned} unsigned, ${s.unknown} by an unknown key, ${s.bad} bad${s.mismatched ? `, ${s.mismatched} with an agent mismatch` : ""}.`,
  );
  if (!report.allowedSigners) console.log(c.dim(`This Roll has no ${ALLOWED_SIGNERS_PATH}, so no signature can be checked against it. Give an agent a key with: gitroll agent-key <name>`));
  console.log(report.ok ? c.green("No bad signatures and no agent mismatches.") : c.red(report.requireSigned && !s.bad && !s.mismatched ? "Not every change is signed by a listed key." : "Some changes didn't verify. See above."));
}

/** Creates (or reuses) an agent's key on this computer and lists it in the Roll. */
export function runAgentKey(roll: GitRoll, rawName: string, json: boolean, c: Colors): void {
  const name = checkAgentName(rawName);
  const key = createAgentKey(name, roll.root);
  const principal = agentPrincipal(name);
  const { added, committed } = roll.addAllowedSigners([allowedSignersLine(principal, key.publicKey)]);
  const result = { agent: name, principal, publicKey: key.publicKey, keyPath: key.path, created: key.created, added: added.length > 0, committed, allowedSigners: ALLOWED_SIGNERS_PATH };
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(key.created ? c.green(`Made a signing key for ${name}.`) : `${name} already has a signing key on this computer.`);
  console.log(c.dim(`Private key: ${key.path} (stays on this computer; never put it in a Roll)`));
  console.log(added.length ? c.green(`Listed ${principal} in ${ALLOWED_SIGNERS_PATH}${committed ? ` and committed it (${committed.slice(0, 12)})` : ""}.`) : `${principal} is already listed in ${ALLOWED_SIGNERS_PATH}.`);
  console.log(c.dim(`GitRoll now signs commits made with --agent "${name}" (or GITROLL_AGENT, or over MCP as that client). Check with: gitroll verify`));
}

/** Doctor's lines about signing, after its existing commit.gpgsign tip. */
export function signingChecks(roll: GitRoll, record: { ok(m: string): void; warn(m: string): void; bad(m: string): void; info(m: string): void }): void {
  const signers = readAllowedSigners(roll.root);
  signers.length
    ? record.ok(`${ALLOWED_SIGNERS_PATH} lists ${signers.length} ${signers.length === 1 ? "signer" : "signers"}, so anyone with the Roll can check who signed what`)
    : record.info(`No ${ALLOWED_SIGNERS_PATH}: signatures can't be checked from the Roll itself. Give an agent a key with: gitroll agent-key <name>`);
  let commits: VerifiedCommit[];
  try {
    const report = verifyCommits(roll, { limit: 50 });
    commits = report.commits;
    const s = report.summary;
    if (s.total) {
      if (s.bad) record.bad(`${s.bad} of the last ${s.total} changes ${s.bad === 1 ? "has a signature" : "have signatures"} that don't match (run: gitroll verify)`);
      if (s.mismatched) record.bad(`${s.mismatched} of the last ${s.total} changes say an agent made them but were signed by someone else (run: gitroll verify)`);
      if (s.good === s.total) record.ok(`The last ${s.total} ${s.total === 1 ? "change is" : "changes are"} signed and verified`);
      else if (!s.bad && !s.mismatched) record.info(`${s.good} of the last ${s.total} changes are signed by a listed key${s.unsigned ? `; ${s.unsigned} unsigned` : ""}${s.unknown ? `; ${s.unknown} by a key the Roll doesn't list` : ""}`);
    }
  } catch {
    commits = [];
  }
  for (const agent of agentsWithoutKeys(roll, commits)) {
    record.info(`The agent "${agent}" made changes here but has no signing key, so its Gitroll-Agent trailer is only a claim. Give it one with: gitroll agent-key "${agent}"`);
  }
}
