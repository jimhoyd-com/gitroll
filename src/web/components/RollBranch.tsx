import { GitBranch } from "lucide-react";
import type { SyncStatus } from "../store.ts";
import { cn } from "../lib/utils.ts";

/*
  Which branch am I writing into?

  A log that lives beside a project moves with that project: check out a feature
  branch and your events are on the feature branch too. That is usually what
  people want, and always what they need to be able to see — so the branch is in
  the header, not in a settings screen.

  This is the *Roll's* branch. An event can also say which branch its work
  happened on (its `source:` block); that is shown on the event itself and
  labelled "Code", because the two are different facts and confusing them would
  be worse than showing neither.
*/

export function RollBranch({ status, className }: { status: SyncStatus; className?: string }) {
  const where = status.repo ?? status.remoteUrl;

  const label = !status.hasCommits
    ? "no commits yet"
    : status.detached
      ? `detached at ${status.head ?? "HEAD"}`
      : (status.branch ?? "unknown branch");

  const title = !status.hasCommits
    ? "This repository has no commits yet. The first event you log makes one."
    : status.detached
      ? `HEAD isn't on a branch, so nothing tracks what you log here. Run git switch -c <branch> to start one. (${status.head})`
      : `The log's own repository is on ${status.branch}${status.head ? ` at ${status.head}` : ""}${where ? `, backed up to ${where}` : ", with no backup yet"}.`;

  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground",
        (status.detached || !status.hasCommits) && "text-del",
        className,
      )}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">This log's branch: </span>
      {where && <span className="max-w-[12rem] truncate">{where}</span>}
      {where && <span aria-hidden="true">·</span>}
      <span className="max-w-[10rem] truncate font-medium">{label}</span>
    </span>
  );
}
