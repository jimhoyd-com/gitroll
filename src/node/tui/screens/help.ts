// What the keys do, what the commands are, what search looks at, and where the
// entries actually live. The one screen that is only words.

import { COMMANDS } from "../commands.ts";
import { bold, fit } from "../text.ts";
import type { Scrolled } from "./chrome.ts";

export function help(root: string, scroll: number, w: number, rows: number): Scrolled {
  // Cut to the width first, then style: fitting a string that already carries
  // styling strips the escape and leaves its digits on screen as "[1m".
  const line = (text: string) => fit(text, w);
  const heading = (text: string) => bold(fit(text, w));
  const lines = [
    heading(" GitRoll, in a terminal"),
    line(""),
    line("  Type what happened at the prompt and press Enter. That's a complete entry."),
    line("  Press / for commands. Everything else is optional."),
    line(""),
    heading(" Commands"),
    ...COMMANDS.map((c) => fit(`   /${c.name.padEnd(10)} ${c.summary}`, w)),
    line(""),
    heading(" Keys"),
    line("   Enter        log what's in the prompt, or open the entry you picked"),
    line("   ↑ ↓          pick an entry above the prompt"),
    line("   Ctrl+O       open the full composer (date, amount, type, tags, topics, files)"),
    line("   Ctrl+S       save, in the composer"),
    line("   Ctrl+E       edit the text in your own editor (EDITOR or VISUAL)"),
    line("   Ctrl+Z       undo the last deletion"),
    line("   Ctrl+R       reload the Roll from its folder"),
    line("   Esc          go back, one step at a time"),
    line("   Ctrl+C       quit (unsaved text is kept as a draft)"),
    line(""),
    heading(" Searching"),
    line("   Looks at: the words of an entry, its title, its topics and tags, its amount,"),
    line("   anything in its front matter, its file name, and the names of files attached to it."),
    line("   Doesn't look at: what's inside those files (no PDF text, no photo text), other"),
    line("   Rolls, deleted entries, or older versions. Just this Roll, as it is right now."),
    line(""),
    line("   Words match anywhere. Filters can be combined:"),
    line("   topic:house  tag:payment  type:expense  after:2026-01-01  before:2026-06-30"),
    line("   amount:>500  has:photo  has:receipt  by:jimmy"),
    line(""),
    heading(" Your entries"),
    line(`   This Roll lives in ${root}`),
    line("   Every entry is a Markdown file in a Git repository you own."),
    line("   Nothing leaves this computer until you back it up with /sync."),
  ];
const at = Math.min(scroll, Math.max(0, lines.length - rows));
return { lines: lines.slice(at), scroll: at };
}
