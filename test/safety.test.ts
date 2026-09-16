import assert from "node:assert/strict";
import test from "node:test";
import { rollSafety, safety, safetyBadge, savedLine } from "../src/core/safety.ts";
import { WEB_SAFETY } from "../src/web/copy.ts";

const CLI = { backup: "Run: gitroll backup", sync: "Run: gitroll sync" };
const TUI = { backup: "Quit and run: gitroll backup", sync: "/sync backs it up." };

test("the answer is about being safe, never about Git's three states", () => {
  // "Saved", "committed" and "pushed" are all true, but a logbook shouldn't
  // make somebody learn Git to know whether their writing is at risk.
  for (const status of [
    {},
    { remote: "origin", remoteUrl: "git@example.com:me/roll.git", ahead: 3 },
    { remote: "origin", remoteUrl: "x", ahead: 0 },
    { blocker: "detached" as const },
  ]) {
    const s = rollSafety(status, CLI);
    assert.doesNotMatch(s.headline, /commit/i, `headline mentions committing: ${s.headline}`);
    assert.doesNotMatch(s.headline, /push|upstream|branch/i, `headline is about Git: ${s.headline}`);
    assert.match(s.headline, /^Saved/, `headline doesn't start with the reassurance: ${s.headline}`);
  }
});

test("every state has one headline and one thing to do", () => {
  assert.equal(safety({}, CLI).level, "here-only");
  assert.equal(safety({}, CLI).action, CLI.backup);

  const behind = safety({ remote: "origin", remoteUrl: "r", ahead: 2 }, CLI);
  assert.equal(behind.level, "to-back-up");
  assert.equal(behind.headline, "Saved here. 2 changes not backed up yet.");
  assert.equal(behind.action, CLI.sync);

  const done = safety({ remote: "origin", remoteUrl: "r", ahead: 0 }, CLI);
  assert.equal(done.level, "backed-up");
  assert.equal(done.action, "", "nothing to do says nothing to do");
  assert.equal(done.tone, "ok");

  const stuck = rollSafety({ blocker: "merging", remote: "origin", ahead: 1 }, CLI);
  assert.equal(stuck.level, "needs-a-hand");
  assert.match(stuck.action, /git merge --continue/);
});

test("hand edits in the folder are counted, not hidden", () => {
  const s = safety({ remote: "origin", remoteUrl: "r", ahead: 0, uncommitted: 1 }, CLI);
  assert.equal(s.level, "to-back-up");
  assert.match(s.headline, /1 file in the folder isn't saved yet/);
});

test("the three interfaces differ only in how you do the thing", () => {
  const status = { remote: "origin", remoteUrl: "r", ahead: 1 };
  const cli = rollSafety(status, CLI);
  const tui = rollSafety(status, TUI);
  const web = rollSafety(status, WEB_SAFETY);
  assert.equal(cli.headline, tui.headline);
  assert.equal(cli.headline, web.headline);
  assert.equal(cli.level, web.level);
  assert.notEqual(cli.action, tui.action, "each says how to do it in its own terms");
});

test("badges are short and never contradict the headline", () => {
  assert.equal(safetyBadge(safety({ remote: "o", remoteUrl: "r" }, CLI), { remote: "o" }), "backed up");
  assert.equal(safetyBadge(safety({}, CLI), {}), "on this computer only");
  assert.equal(safetyBadge(safety({ remote: "o", ahead: 4 }, CLI), { remote: "o", ahead: 4 }), "4 to back up");
});

test("the line after logging assumes the save that just happened", () => {
  // Git's status can still say zero: the count is read after the commit, but a
  // stale read must never tell somebody their new entry is already backed up.
  assert.match(savedLine({ remote: "o", remoteUrl: "r", ahead: 0 }, CLI), /not backed up yet\. Run: gitroll sync/);
  assert.doesNotMatch(savedLine({ remote: "o", remoteUrl: "r", ahead: 0 }, CLI), /^Saved here/);
  assert.match(savedLine({}, CLI), /^Saved on this computer only\./);
});
