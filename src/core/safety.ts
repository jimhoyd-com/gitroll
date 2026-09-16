// Is what I just wrote safe, and do I have to do anything about it?
//
// GitRoll has three true states — written to a file, committed, and pushed to a
// backup — and saying all three is how a person ends up having to understand
// Git before they can trust a logbook. Writing and committing happen together
// and never come apart, so there are only two things worth telling somebody:
// **it is saved here**, and **whether a copy of it exists anywhere else**.
//
// One answer, computed once, worded once. The terminal, the browser and the CLI
// differ only in how you carry out the suggestion, which each of them passes in.

/** A Git state that stops syncing until a person clears it. */
export type SyncBlocker = "detached" | "merging" | "rebasing";

/** What the person has to do about a Git state that stops syncing — and what still works meanwhile. */
export function describeBlocker(blocker: SyncBlocker): string {
  switch (blocker) {
    case "detached":
      return "This folder isn't on a branch, so GitRoll can't back it up. Logging still works and nothing is lost. To get back: git checkout main";
    case "merging":
      return "A merge is unfinished in this folder, so GitRoll won't sync on top of it. Logging still works. Finish it with: git merge --continue (or git merge --abort)";
    case "rebasing":
      return "A rebase is unfinished in this folder, so GitRoll won't sync on top of it. Logging still works. Finish it with: git rebase --continue (or git rebase --abort)";
  }
}

export interface SafetyStatus {
  /** Why syncing can't run at all, if anything. */
  blocker?: string | null;
  /** Where the backup is, if there is one. */
  remote?: string | null;
  remoteUrl?: string | null;
  /** Commits made here and not yet in the backup. */
  ahead?: number;
  /** Files changed in .gitroll/ that no commit has recorded — hand edits, mostly. */
  uncommitted?: number;
}

/** How each interface says "do the thing", so the advice is one they can follow. */
export interface SafetyCommands {
  /** Start backing this Roll up for the first time. */
  backup: string;
  /** Send what's here to the backup. */
  sync: string;
}

export type SafetyLevel = "backed-up" | "here-only" | "to-back-up" | "needs-a-hand";

export interface Safety {
  level: SafetyLevel;
  /** The whole answer in one line, safe to show on its own. */
  headline: string;
  /** What to do about it, or "" when the answer is "nothing". */
  action: string;
  /** The same thing at length, for a details panel or `gitroll status`. */
  detail: string;
  tone: "ok" | "info" | "warn";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What to tell somebody about the state of their Roll.
 *
 * "Saved" always means written down and committed: GitRoll does both in one
 * step, and an entry is never one without the other. Everything else is about
 * whether a copy exists somewhere that isn't this computer.
 */
export function safety(status: SafetyStatus, commands: SafetyCommands): Safety {
  const ahead = status.ahead ?? 0;
  const uncommitted = status.uncommitted ?? 0;
  // Files somebody edited in the folder by hand. GitRoll didn't write them, so
  // it hasn't saved them either, and saying so is the whole of what's owed.
  const hand = uncommitted
    ? `${plural(uncommitted, "file", "files")} in the folder ${uncommitted === 1 ? "isn't" : "aren't"} saved yet (changed outside GitRoll).`
    : "";

  if (status.blocker) {
    return {
      level: "needs-a-hand",
      headline: "Saved here. Backing up needs a hand.",
      action: status.blocker,
      detail: [hand, status.blocker].filter(Boolean).join(" "),
      tone: "warn",
    };
  }
  if (!status.remote) {
    return {
      level: "here-only",
      headline: "Saved on this computer only.",
      action: commands.backup,
      detail:
        [`Everything you have logged is saved here and nowhere else.`, hand, `If this computer is lost, so is the Roll.`, commands.backup]
          .filter(Boolean)
          .join(" "),
      tone: "info",
    };
  }
  if (ahead > 0 || uncommitted > 0) {
    return {
      level: "to-back-up",
      headline:
        ahead > 0
          ? `Saved here. ${plural(ahead, "change", "changes")} not backed up yet.`
          : `Saved here. ${plural(uncommitted, "file", "files")} in the folder ${uncommitted === 1 ? "isn't" : "aren't"} saved yet.`,
      action: commands.sync,
      detail: [
        ahead > 0
          ? `${plural(ahead, "change is", "changes are")} saved on this computer but not yet at ${status.remoteUrl ?? "your backup"}.`
          : "",
        hand,
        commands.sync,
      ]
        .filter(Boolean)
        .join(" "),
      tone: "info",
    };
  }
  return {
    level: "backed-up",
    headline: "Saved and backed up.",
    action: "",
    detail: `Everything here is saved and backed up to ${status.remoteUrl ?? "your backup"}. There is nothing to do.`,
    tone: "ok",
  };
}

/** The short form for a header or a status line: "backed up", "3 to back up". */
export function safetyBadge(s: Safety, status: SafetyStatus): string {
  switch (s.level) {
    case "backed-up":
      return "backed up";
    case "here-only":
      return "on this computer only";
    case "needs-a-hand":
      return "needs a hand";
    default:
      return status.ahead ? `${status.ahead} to back up` : "not backed up yet";
  }
}

/** The same answer, from the Git status every interface already has to hand. */
export function rollSafety(
  status: { blocker?: SyncBlocker | null; remote?: string | null; remoteUrl?: string | null; ahead?: number; uncommitted?: number },
  commands: SafetyCommands,
): Safety {
  return safety(
    {
      blocker: status.blocker ? describeBlocker(status.blocker) : null,
      remote: status.remote ?? null,
      remoteUrl: status.remoteUrl ?? null,
      ahead: status.ahead,
      uncommitted: status.uncommitted,
    },
    commands,
  );
}

/**
 * What to say the moment something is logged. The save has just happened, so
 * there is at least one change to back up whatever the Git status last said,
 * and the "Saved here" half has already been said by the word "Logged".
 */
export function savedLine(
  status: { blocker?: SyncBlocker | null; remote?: string | null; remoteUrl?: string | null; ahead?: number; uncommitted?: number },
  commands: SafetyCommands,
): string {
  const s = rollSafety({ ...status, ahead: Math.max(status.ahead ?? 0, 1) }, commands);
  return [s.headline.replace(/^Saved here\. /, ""), s.action].filter(Boolean).join(" ");
}
