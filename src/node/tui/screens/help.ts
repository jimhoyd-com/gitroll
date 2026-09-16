// What the keys do, what the commands are, what search looks at, and where the
// entries actually live. The one screen that is only words.

import { COMMANDS } from "../commands.ts";
import { bold, fit } from "../text.ts";
import type { Scrolled } from "./chrome.ts";

export function help(root: string, scroll: number, w: number, rows: number): Scrolled {
  const lines = [
    bold(" GitRoll, in a terminal"),
    "",
    "  Type what happened at the prompt and press Enter. That's a complete entry.",
    "  Press / for commands. Everything else is optional.",
    "",
    bold(" Commands"),
    ...COMMANDS.map((c) => fit(`   /${c.name.padEnd(10)} ${c.summary}`, w)),
    "",
    bold(" Keys"),
    "   Enter        log what's in the prompt, or open the entry you picked",
    "   ↑ ↓          pick an entry above the prompt",
    "   Ctrl+O       open the full composer (date, amount, type, tags, topics, files)",
    "   Ctrl+S       save, in the composer",
    "   Ctrl+E       edit the text in your own editor (EDITOR or VISUAL)",
    "   Ctrl+Z       undo the last deletion",
    "   Ctrl+R       reload the Roll from its folder",
    "   Esc          go back, one step at a time",
    "   Ctrl+C       quit (unsaved text is kept as a draft)",
    "",
    bold(" Searching"),
    "   Looks at: the words of an entry, its title, its topics and tags, its amount,",
    "   anything in its front matter, its file name, and the names of files attached to it.",
    "   Doesn't look at: what's inside those files (no PDF text, no photo text), other",
    "   Rolls, deleted entries, or older versions. Just this Roll, as it is right now.",
    "",
    "   Words match anywhere. Filters can be combined:",
    "   topic:house  tag:payment  type:expense  after:2026-01-01  before:2026-06-30",
    "   amount:>500  has:photo  has:receipt  by:jimmy",
    "",
    bold(" Your entries"),
    `   This Roll lives in ${root}`,
    "   Every entry is a Markdown file in a Git repository you own.",
    "   Nothing leaves this computer until you back it up with /sync.",
  ].map((l) => fit(l, w));
const at = Math.min(scroll, Math.max(0, lines.length - rows));
return { lines: lines.slice(at), scroll: at };
}
