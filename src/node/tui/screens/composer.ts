// The composer, drawn: every field of an event at once, with the one being
// edited kept on screen.

import type { Composer } from "../compose.ts";
import { bold, caret, caretLines, dim, fit, inverse } from "../text.ts";

export function composerView(c: Composer, w: number, rows: number): string[] {
  const title = c.mode === "edit" ? "Edit this entry" : c.mode === "duplicate" ? "Log a copy" : "Log something";
  const lines: string[] = [bold(` ${title}`), ""];
  let focusLine = 0;
  c.fields().forEach((f, i) => {
    const focused = i === c.index;
    if (focused) focusLine = lines.length;
    lines.push(focused ? bold(` ▸ ${f.label}`) : dim(`   ${f.label}`));
    const input = c.input(f.key);
    const room = w - 6;
    if (f.kind === "multiline") {
      const shown = caretLines(input, room, focused);
      for (const l of focused || input.value ? shown : [dim("…")]) lines.push(`     ${l}`);
    } else {
      lines.push(`     ${focused ? caret(input.value, input.cursor, room) : input.value ? fit(input.value, room) : dim("—")}`);
    }
    if (focused && c.suggestions.length) {
      lines.push(dim(`     ${c.suggestions.map((s, n) => (n === c.suggestion ? inverse(` ${s} `) : ` ${s} `)).join("")}  Tab completes`));
    } else if (focused && f.hint) lines.push(dim(fit(`     ${f.hint}`, w)));
    lines.push("");
  });
  // Keep the field being edited on screen.
  const start = Math.max(0, Math.min(focusLine - Math.floor(rows / 2), lines.length - rows));
  return lines.slice(focusLine < rows - 2 ? 0 : start);
}
