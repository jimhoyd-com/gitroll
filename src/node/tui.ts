// Full-screen terminal app: move with the arrow keys, log, find, read, sync and switch Rolls.
// `Tui` is a plain model (keys in, lines out) so it can be tested without a terminal;
// `runTui` connects it to a real one. No dependencies.
import readline from "node:readline";
import type { LoadedEntry } from "../core/layout.ts";
import { SearchIndex } from "../core/search.ts";
import { typeRegistry } from "../core/types.ts";
import { UserError } from "../core/util.ts";
import type { FileInput, GitRoll } from "./repo.ts";

export interface Key {
  /** Named keys: up, down, left, right, return, escape, backspace, delete, tab, home, end, pageup, pagedown. */
  name?: string;
  /** A printable character typed or pasted. */
  ch?: string;
  ctrl?: boolean;
}

export interface TuiEnv {
  roll: GitRoll;
  rolls(): { key: string; name: string; path: string }[];
  openRoll(path: string): GitRoll;
  readFile(path: string): FileInput;
  /** Starts the local web app for a Roll and returns its address. */
  openInBrowser(roll: GitRoll): Promise<string>;
}

type Screen = "timeline" | "entry" | "compose" | "rolls";
type Field = "text" | "project" | "files";
const FIELDS: Field[] = ["text", "project", "files"];

class Input {
  value = "";
  cursor = 0;
  /** Returns true when the key edited the text. */
  key(k: Key): boolean {
    const v = this.value;
    if (k.ctrl && k.name === "u") [this.value, this.cursor] = ["", 0];
    else if (k.ctrl && k.name === "a") this.cursor = 0;
    else if (k.ctrl && k.name === "e") this.cursor = [...v].length;
    else if (k.ch && !k.ctrl) {
      const chars = [...v];
      chars.splice(this.cursor, 0, ...k.ch);
      this.value = chars.join("");
      this.cursor += [...k.ch].length;
    } else if (k.name === "backspace" && this.cursor > 0) {
      const chars = [...v];
      chars.splice(--this.cursor, 1);
      this.value = chars.join("");
    } else if (k.name === "delete") {
      const chars = [...v];
      chars.splice(this.cursor, 1);
      this.value = chars.join("");
    } else if (k.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (k.name === "right") this.cursor = Math.min([...v].length, this.cursor + 1);
    else if (k.name === "home") this.cursor = 0;
    else if (k.name === "end") this.cursor = [...v].length;
    else return false;
    return true;
  }
  clear(): void {
    [this.value, this.cursor] = ["", 0];
  }
}

// ── Styling ─────────────────────────────────────────────────────────────────

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = esc("1");
const dim = esc("2");
const inverse = esc("7");
const green = esc("32");
const red = esc("31");
const yellow = esc("33");

/** Cuts plain text to a width (by code point; wide characters may overhang slightly). */
function fit(s: string, width: number): string {
  const chars = [...s.replace(/[\x00-\x1f\x7f]/g, " ")];
  return chars.length <= width ? s.replace(/[\x00-\x1f\x7f]/g, " ") : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if ([...line].length + [...word].length > width && line.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
      while ([...line].length > width) {
        out.push([...line].slice(0, width).join(""));
        line = [...line].slice(width).join("");
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Splits dragged-in or pasted paths: quoted, or with backslash-escaped spaces. */
export function parsePaths(input: string): string[] {
  return [...input.matchAll(/'([^']*)'|"([^"]*)"|((?:\\.|\S)+)/g)].map((m) => m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, "$1"));
}

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

// ── Model ───────────────────────────────────────────────────────────────────

export class Tui {
  env: TuiEnv;
  roll: GitRoll;
  screen: Screen = "timeline";
  done = false;
  message = "";
  tone: "info" | "ok" | "error" = "info";
  busy = false;

  entries: LoadedEntry[] = [];
  #index: SearchIndex<LoadedEntry> | null = null;
  #names = new Map<string, string>();
  finding = false;
  find = new Input();
  selected = 0;
  scroll = 0;

  current: LoadedEntry | null = null;
  entryScroll = 0;
  confirmDelete = false;

  field: Field = "text";
  text = new Input();
  files = new Input();
  newProject = new Input();
  projectIndex = 0;

  rollList: { key: string; name: string; path: string }[] = [];
  rollSelected = 0;

  constructor(env: TuiEnv) {
    this.env = env;
    this.roll = env.roll;
    this.reload();
  }

  reload(): void {
    const entries = this.roll.entries();
    this.#names = new Map(this.roll.projects().map((p) => [p.slug, p.name]));
    const registry = typeRegistry(this.roll.types());
    this.#index = new SearchIndex(entries, { projectNames: this.#names, typeLabels: new Map([...registry.values()].map((t) => [t.id, t.label])) });
    this.entries = entries;
    this.selected = Math.min(this.selected, Math.max(0, this.visible().length - 1));
  }

  /** Entries shown on the timeline: everything, or what matches the search. */
  visible(): LoadedEntry[] {
    const q = this.find.value.trim();
    return q && this.#index ? this.#index.search(q) : this.entries;
  }

  say(message: string, tone: Tui["tone"] = "info"): void {
    this.message = message;
    this.tone = tone;
  }

  async key(k: Key): Promise<void> {
    if (k.ctrl && k.name === "c") {
      this.done = true;
      return;
    }
    if (this.busy) return;
    if (k.name !== undefined || k.ch !== undefined) this.message = this.confirmDelete ? this.message : "";
    try {
      if (this.screen === "timeline") await this.#timeline(k);
      else if (this.screen === "entry") this.#entry(k);
      else if (this.screen === "compose") this.#compose(k);
      else this.#rolls(k);
    } catch (e) {
      this.busy = false;
      this.say(e instanceof UserError ? e.message : String((e as Error).message ?? e), "error");
    }
  }

  async #timeline(k: Key): Promise<void> {
    const list = this.visible();
    if (this.finding) {
      if (k.name === "escape") {
        this.finding = false;
        this.find.clear();
        this.selected = 0;
      } else if (k.name === "return" || k.name === "down") {
        this.finding = false;
        if (k.name === "return" && list.length) this.#openEntry(list[this.selected]);
      } else if (this.find.key(k)) this.selected = 0;
      return;
    }
    switch (k.name ?? k.ch) {
      case "up":
      case "k":
        this.selected = Math.max(0, this.selected - 1);
        break;
      case "down":
      case "j":
        this.selected = Math.min(list.length - 1, this.selected + 1);
        break;
      case "pageup":
        this.selected = Math.max(0, this.selected - 10);
        break;
      case "pagedown":
        this.selected = Math.min(list.length - 1, this.selected + 10);
        break;
      case "return":
      case "right":
        if (list[this.selected]) this.#openEntry(list[this.selected]);
        break;
      case "n":
      case "a":
        this.#startCompose();
        break;
      case "/":
      case "f":
        this.finding = true;
        break;
      case "escape":
        if (this.find.value) {
          this.find.clear();
          this.selected = 0;
        }
        break;
      case "s":
        await this.#sync();
        break;
      case "r":
        this.rollList = this.env.rolls();
        this.rollSelected = Math.max(0, this.rollList.findIndex((r) => r.path === this.roll.root));
        this.screen = "rolls";
        break;
      case "o": {
        this.busy = true;
        this.say("Opening in your browser…");
        const url = await this.env.openInBrowser(this.roll);
        this.busy = false;
        this.say(`Open in your browser while this stays running: ${url}`, "ok");
        break;
      }
      case "q":
        this.done = true;
        break;
    }
  }

  async #sync(): Promise<void> {
    if (!this.roll.status().remote) {
      this.say("This Roll isn't backed up yet. To back it up, quit and run: gitroll backup", "error");
      return;
    }
    this.busy = true;
    this.say("Syncing…");
    this.onChange?.();
    const result = await this.roll.sync();
    this.busy = false;
    this.reload();
    this.say(result.message, result.ok ? "ok" : "error");
  }

  /** Called when the screen should be redrawn in the middle of a slow action. */
  onChange?: () => void;

  #openEntry(e: LoadedEntry): void {
    this.current = e;
    this.entryScroll = 0;
    this.confirmDelete = false;
    this.screen = "entry";
  }

  #entry(k: Key): void {
    if (this.confirmDelete) {
      this.confirmDelete = false;
      if (k.ch === "y" || k.ch === "Y") {
        this.roll.deleteEntry(this.current!.id);
        this.reload();
        this.screen = "timeline";
        this.say("Deleted.", "ok");
      } else this.say("Kept it.");
      return;
    }
    switch (k.name ?? k.ch) {
      case "escape":
      case "left":
      case "backspace":
      case "q":
        this.screen = "timeline";
        break;
      case "up":
      case "k":
        this.entryScroll = Math.max(0, this.entryScroll - 1);
        break;
      case "down":
      case "j":
        this.entryScroll++;
        break;
      case "d":
        this.confirmDelete = true;
        this.say("Delete this entry? It stays in the Roll's history. Press y to delete, any other key to keep it.", "error");
        break;
    }
  }

  #startCompose(): void {
    this.text.clear();
    this.files.clear();
    this.newProject.clear();
    this.projectIndex = 0;
    this.field = "text";
    this.screen = "compose";
  }

  #compose(k: Key): void {
    const i = FIELDS.indexOf(this.field);
    if (k.name === "escape") {
      this.screen = "timeline";
      this.say("Nothing logged.");
      return;
    }
    if (k.name === "tab" || k.name === "down") {
      this.field = FIELDS[(i + 1) % FIELDS.length];
      return;
    }
    if (k.name === "up") {
      this.field = FIELDS[(i + FIELDS.length - 1) % FIELDS.length];
      return;
    }
    if (k.name === "return") {
      if (k.ctrl || this.field === "files" || !this.text.value.trim()) {
        if (this.text.value.trim()) this.#save();
        else {
          this.field = "text";
          this.say("Type what happened first.", "error");
        }
      } else this.field = FIELDS[i + 1];
      return;
    }
    if (this.field === "text") this.text.key(k);
    else if (this.field === "files") this.files.key(k);
    else {
      const count = this.roll.projects().length + 1;
      if (k.name === "left" || k.name === "right") {
        this.newProject.clear();
        this.projectIndex = (this.projectIndex + (k.name === "right" ? 1 : count - 1)) % count;
      } else this.newProject.key(k);
    }
  }

  #save(): void {
    const projects = this.roll.projects();
    const project = this.newProject.value.trim() || (this.projectIndex ? projects[this.projectIndex - 1].slug : "");
    const files = parsePaths(this.files.value).map((p) => this.env.readFile(p));
    const { notices } = this.roll.save({ text: this.text.value.trim(), projects: project ? [project] : [] }, files);
    this.find.clear();
    this.reload();
    this.selected = 0;
    this.screen = "timeline";
    this.say(["Logged.", ...notices].join(" "), notices.length ? "error" : "ok");
  }

  #rolls(k: Key): void {
    switch (k.name ?? k.ch) {
      case "escape":
      case "q":
        this.screen = "timeline";
        break;
      case "up":
      case "k":
        this.rollSelected = Math.max(0, this.rollSelected - 1);
        break;
      case "down":
      case "j":
        this.rollSelected = Math.min(this.rollList.length - 1, this.rollSelected + 1);
        break;
      case "return": {
        const chosen = this.rollList[this.rollSelected];
        if (!chosen) break;
        this.roll = this.env.openRoll(chosen.path);
        this.find.clear();
        this.selected = 0;
        this.reload();
        this.screen = "timeline";
        this.say(`Switched to ${this.roll.config().name}.`, "ok");
        break;
      }
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  render(width: number, height: number): string[] {
    const w = Math.max(20, width);
    const h = Math.max(8, height);
    const body = this.screen === "timeline" ? this.#drawTimeline(w, h - 4) : this.screen === "entry" ? this.#drawEntry(w, h - 4) : this.screen === "compose" ? this.#drawCompose(w) : this.#drawRolls(w, h - 4);
    const status = this.roll.status();
    const sync = !status.remote ? "not backed up" : status.ahead ? `${status.ahead} to sync` : "synced";
    const title = ` GitRoll · ${this.roll.config().name}`;
    const header = `${bold(fit(title, w - sync.length - 2))}${" ".repeat(Math.max(1, w - [...fit(title, w - sync.length - 2)].length - sync.length - 1))}${(status.ahead || !status.remote ? yellow : green)(sync)}`;
    const lines = [header, dim("─".repeat(w)), ...body.slice(0, h - 4)];
    while (lines.length < h - 2) lines.push("");
    const paint = this.tone === "ok" ? green : this.tone === "error" ? red : dim;
    lines.push(this.message ? paint(fit(` ${this.message}`, w)) : "");
    lines.push(dim(fit(` ${this.#keys()}`, w)));
    return lines;
  }

  #keys(): string {
    if (this.screen === "entry") return this.confirmDelete ? "y delete · any other key keeps it" : "← back · ↑↓ scroll · d delete";
    if (this.screen === "compose") return "Enter next · Tab/↑↓ move between fields · Ctrl+Enter or Enter on Files saves · Esc cancel";
    if (this.screen === "rolls") return "↑↓ choose · Enter switch · Esc back";
    if (this.finding) return "type to search · Enter open · ↓ results · Esc clear";
    return "↑↓ move · Enter open · n new · / find · s sync · r rolls · o browser · q quit";
  }

  #drawTimeline(w: number, rows: number): string[] {
    const out: string[] = [];
    if (this.finding || this.find.value) {
      out.push(` Find: ${this.finding ? this.#caret(this.find, w - 8) : this.find.value}`);
      out.push("");
      rows -= 2;
    }
    const list = this.visible();
    if (!list.length) {
      out.push(dim(this.find.value ? "  Nothing found." : "  Nothing logged yet. Press n to log something."));
      return out;
    }
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + rows) this.scroll = this.selected - rows + 1;
    for (let i = this.scroll; i < Math.min(list.length, this.scroll + rows); i++) {
      const e = list[i];
      const d = new Date(e.occurred);
      const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).padEnd(7);
      const labels = [e.type !== "log" ? e.type : "", ...e.projects.map((p) => this.#names.get(p) ?? p), e.attachments.length ? `${e.attachments.length} file${e.attachments.length === 1 ? "" : "s"}` : ""]
        .filter(Boolean)
        .join(" · ");
      const first = (e.body || "(no text)").split("\n")[0];
      const room = w - 4 - date.length - (labels ? [...labels].length + 2 : 0);
      const plain = `${date} ${fit(first, Math.max(8, room))}`;
      const pad = " ".repeat(Math.max(1, w - 2 - [...plain].length - [...labels].length));
      const row = `${plain}${pad}${labels}`;
      out.push(i === this.selected && !this.finding ? inverse(fit(`▸ ${row}`, w)) : `  ${fit(row, w - 2).replace(labels, dim(labels))}`);
    }
    return out;
  }

  #drawEntry(w: number, rows: number): string[] {
    const e = this.current!;
    const meta = [e.type !== "log" ? e.type : "", ...e.projects.map((p) => this.#names.get(p) ?? p)].filter(Boolean).join(" · ");
    const lines = [` ${bold(when(e.occurred))}${meta ? `  ${meta}` : ""}`, ""];
    for (const l of wrap(e.body || "(no text)", w - 2)) lines.push(` ${l}`);
    lines.push("");
    if (e.amount) lines.push(dim(` Amount: ${e.amount.value} ${e.amount.currency}`));
    if (e.tags.length) lines.push(dim(` Tags: ${e.tags.map((t) => `#${t}`).join(" ")}`));
    for (const a of e.attachments) lines.push(dim(fit(` File: ${a.name}`, w)));
    for (const [k, v] of Object.entries(e.data ?? {})) lines.push(dim(fit(` ${k}: ${String(v)}`, w)));
    lines.push(dim(` By ${e.author} · ${e.id.replace(/-/g, "").slice(-8)}`));
    this.entryScroll = Math.min(this.entryScroll, Math.max(0, lines.length - rows));
    return lines.slice(this.entryScroll);
  }

  #drawCompose(w: number): string[] {
    const projects = this.roll.projects();
    const label = (f: Field, text: string) => (this.field === f ? bold(`▸ ${text}`) : `  ${text}`);
    const project = this.newProject.value
      ? this.field === "project"
        ? `New project: ${this.#caret(this.newProject, w - 30)}`
        : `New project: ${this.newProject.value}`
      : `‹ ${this.projectIndex ? projects[this.projectIndex - 1].name : "No project"} ›${this.field === "project" ? dim("  ←→ choose, or type a new name") : ""}`;
    return [
      bold(" Log something"),
      "",
      label("text", "What happened?"),
      `   ${this.field === "text" ? this.#caret(this.text, w - 4) : fit(this.text.value || dim("…"), w - 4)}`,
      "",
      label("project", "Project"),
      `   ${project}`,
      "",
      label("files", "Photos or files"),
      `   ${this.field === "files" ? this.#caret(this.files, w - 4) : fit(this.files.value, w - 4) || dim("Drag files here, or leave empty")}`,
    ];
  }

  #drawRolls(w: number, rows: number): string[] {
    if (!this.rollList.length) return [dim("  No other Rolls yet. Quit and run: gitroll new \"Name\"")];
    return [
      bold(" Your Rolls"),
      "",
      ...this.rollList.slice(0, rows - 2).map((r, i) => {
        const row = `${r.name}${r.path === this.roll.root ? "  (open)" : ""}`;
        return i === this.rollSelected ? inverse(fit(`▸ ${row}`, w)) : `  ${fit(row, w - 2)}`;
      }),
    ];
  }

  /** An input line with a visible cursor, scrolled so the cursor stays in view. */
  #caret(input: Input, width: number): string {
    const chars = [...input.value.replace(/[\x00-\x1f\x7f]/g, " ")];
    const start = Math.max(0, input.cursor - width + 1);
    const before = chars.slice(start, input.cursor).join("");
    const at = chars[input.cursor] ?? " ";
    const after = chars.slice(input.cursor + 1, start + width).join("");
    return `${before}${inverse(at)}${after}`;
  }
}

// ── Terminal ────────────────────────────────────────────────────────────────

export function tuiSupported(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.TERM !== "dumb";
}

export async function runTui(env: TuiEnv): Promise<void> {
  const tui = new Tui(env);
  const out = process.stdout;
  const draw = () => {
    const lines = tui.render(out.columns ?? 80, out.rows ?? 24);
    out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J`);
  };
  tui.onChange = draw;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  out.write("\x1b[?1049h\x1b[?25l");
  const restore = () => {
    out.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  process.on("exit", restore);
  out.on("resize", draw);
  draw();
  try {
    await new Promise<void>((resolve) => {
      let queue = Promise.resolve();
      const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } = {}) => {
        const named = ["up", "down", "left", "right", "return", "enter", "escape", "backspace", "delete", "tab", "home", "end", "pageup", "pagedown"];
        const k: Key = key.name && (named.includes(key.name) || key.ctrl) ? { name: key.name === "enter" ? "return" : key.name, ctrl: key.ctrl } : str && !key.ctrl && !key.meta ? { ch: str } : {};
        queue = queue.then(async () => {
          await tui.key(k);
          draw();
          if (tui.done) {
            process.stdin.off("keypress", onKey);
            resolve();
          }
        });
      };
      process.stdin.on("keypress", onKey);
    });
  } finally {
    out.off("resize", draw);
    process.off("exit", restore);
    restore();
    process.stdin.pause();
  }
}
