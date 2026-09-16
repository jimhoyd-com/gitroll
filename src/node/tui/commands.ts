// The commands behind "/": what they are called, what they are for, and which
// of them the letters someone has typed could mean.

export interface Command {
  name: string;
  summary: string;
  /** Extra words that should also find this command. */
  also?: string[];
}

export const COMMANDS: Command[] = [
  { name: "log", summary: "Write an entry with date, amount, tags, topics and files", also: ["new", "add", "compose"] },
  { name: "find", summary: "Search your entries as you type, with filters", also: ["search"] },
  { name: "topics", summary: "Browse topics and what's logged in them", also: ["projects", "project"] },
  { name: "roll", summary: "Switch to another Roll", also: ["rolls", "switch"] },
  { name: "sync", summary: "Back up to your remote and get others' changes", also: ["backup", "push"] },
  { name: "status", summary: "Where this Roll lives, what's saved and what's backed up" },
  { name: "save", summary: "Commit log records that are written but not committed yet", also: ["commit"] },
  { name: "undo", summary: "Undo the last deletion" },
  { name: "deleted", summary: "Events you deleted, and put any of them back", also: ["restore", "recover", "trash"] },
  { name: "problems", summary: "Files in this Roll that GitRoll can't read", also: ["errors", "broken"] },
  { name: "web", summary: "Open this Roll in your browser", also: ["browser", "open"] },
  { name: "help", summary: "Keys and commands", also: ["keys", "?"] },
  { name: "quit", summary: "Leave GitRoll", also: ["exit"] },
];

/** Commands matching what's been typed after the "/", best first. */
export function matchCommands(typed: string): Command[] {
  const q = typed.replace(/^\//, "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!q) return COMMANDS;
  const score = (c: Command) => (c.name.startsWith(q) ? 0 : c.also?.some((a) => a.startsWith(q)) ? 1 : c.name.includes(q) ? 2 : 3);
  return COMMANDS.filter((c) => score(c) < 3).sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}
