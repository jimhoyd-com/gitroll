// The screens that are a list and a choice: your Rolls, the files GitRoll
// can't read, and the entries you deleted.

import type { Problem } from "../../../core/layout.ts";
import type { DeletedEntry } from "../../repo.ts";
import { bold, day, dim, fit } from "../text.ts";
import { list, note } from "./chrome.ts";

export interface RollChoice {
  key: string;
  name: string;
  path: string;
}

export function rolls(items: RollChoice[], open: string, index: number, w: number, rows: number): string[] {
  if (!items.length) return [dim('  No Rolls yet. Quit and run: gitroll new "Name"')];
  const lines = items.map((r) => `${r.name}${r.path === open ? "  (open)" : ""}   ${r.path}`);
  return [bold(" Your Rolls"), "", ...list(lines, index, 0, w, Math.max(1, rows - 2)).lines];
}

const UNREADABLE = "They're still in the Roll, exactly as they were written. Fix the part named and GitRoll picks them up again.";

export function problems(items: Problem[], index: number, w: number, rows: number): string[] {
  if (!items.length) return [dim("  Every file in this Roll reads cleanly.")];
  const lines = items.map((p) => `${p.path}  ${p.error}`);
  const said = note(UNREADABLE, w);
  return [bold(" Files GitRoll can't read"), ...said, "", ...list(lines, index, 0, w, Math.max(1, rows - 2 - said.length)).lines];
}

const DELETING = "Deleting only takes an event off the timeline. Putting one back is a new change, so the history still shows both.";

export function deleted(items: DeletedEntry[], index: number, w: number, rows: number): string[] {
  if (!items.length) return [dim("  Nothing has been removed from this Roll."), "", dim("  Anything deleted stays in the history, and would be listed here.")];
  // The title, not the first body line: that line is the entry's own heading, hash and all.
  const lines = items.map((d) => `${day(d.deletedAt).padEnd(7)} ${fit(d.entry.title || "(no text)", Math.max(8, w - 12))}`);
  const said = note(DELETING, w);
  return [bold(" History · entries removed from this Roll"), ...said, "", ...list(lines, index, 0, w, Math.max(1, rows - 2 - said.length)).lines];
}
