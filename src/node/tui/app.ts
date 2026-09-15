// GitRoll's interactive workspace: a persistent prompt with recent entries above
// it, a "/" command menu, a full entry composer and a live search.
//
// `Tui` is a plain model (keys in, lines out) so every behavior is testable
// without a terminal; `runTui` connects it to a real one. No dependencies.

import readline from "node:readline";
import type { LoadedEntry } from "../../core/layout.ts";
import { SearchIndex, facets } from "../../core/search.ts";
import { UserError } from "../../core/util.ts";
import type { FileInput, GitRoll, SyncStatus } from "../repo.ts";
import { Composer } from "./compose.ts";
import type { ComposeMode, ComposerContext, Draft } from "./compose.ts";
import { Input, bold, caret, caretLines, clean, cyan, day, dim, fit, green, inverse, pad, parsePaths, red, spread, when, wrap, yellow } from "./text.ts";
import type { Key } from "./text.ts";

export type { Key } from "./text.ts";
export { parsePaths } from "./text.ts";

/** Where unsaved composer drafts are kept between runs. Never inside a Roll. */
export interface DraftStore {
  load(rollRoot: string): Draft | null;
  save(rollRoot: string, draft: Draft): void;
  clear(rollRoot: string): void;
}

export interface TuiEnv {
  roll: GitRoll;
  rolls(): { key: string; name: string; path: string }[];
  openRoll(path: string): GitRoll;
  readFile(path: string): FileInput;
  /** Starts the local web app for a Roll and returns its address. */
  openInBrowser(roll: GitRoll): Promise<string>;
  /** Remembers the Roll to open next time. */
  rememberRoll?(path: string): void;
  drafts?: DraftStore;
  /** Opens the text in the person's own editor and returns what they saved. */
  editExternally?(text: string): string | null;
}

type Screen = "home" | "compose" | "find" | "entry" | "history" | "rolls" | "topics" | "help";

export interface Command {
  name: string;
  summary: string;
  /** Extra words that should also find this command. */
  also?: string[];
}

export const COMMANDS: Command[] = [
  { name: "log", summary: "Write an entry with date, amount, type, tags, topics and files", also: ["new", "add", "compose"] },
  { name: "find", summary: "Search your entries as you type, with filters", also: ["search"] },
  { name: "topics", summary: "Browse topics and what's logged in them", also: ["projects", "project"] },
  { name: "roll", summary: "Switch to another Roll", also: ["rolls", "switch"] },
  { name: "sync", summary: "Back up to your remote and get others' changes", also: ["backup", "push"] },
  { name: "status", summary: "Where this Roll lives, what's saved and what's backed up" },
  { name: "undo", summary: "Undo the last deletion" },
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

interface Deleted {
  entry: LoadedEntry;
}

export class Tui {
  env: TuiEnv;
  roll: GitRoll;
  screen: Screen = "home";
  done = false;
  message = "";
  tone: "info" | "ok" | "error" = "info";
  busy = false;
  /** Called when the screen should be redrawn in the middle of a slow action. */
  onChange?: () => void;

  entries: LoadedEntry[] = [];
  #index: SearchIndex<LoadedEntry> | null = null;
  #names = new Map<string, string>();
  #tags: string[] = [];
  #statusValue: SyncStatus | null = null;
  #statusAt = 0;

  /** The persistent prompt at the bottom of the workspace. */
  prompt = new Input();
  menuIndex = 0;
  /** Which recent entry is picked: -1 is the prompt, 0 the newest entry. */
  homeIndex = -1;
  homeScroll: number | null = null;

  /** Search state, kept so returning to /find lands where you left off. */
  find = new Input();
  findIndex = 0;
  findScroll = 0;

  current: LoadedEntry | null = null;
  entryScroll = 0;
  attaching: Input | null = null;
  historyScroll = 0;
  #history: { date: string; author: string; subject: string }[] = [];

  composer: Composer | null = null;
  rollList: { key: string; name: string; path: string }[] = [];
  rollIndex = 0;
  topicIndex = 0;
  helpScroll = 0;

  #deleted: Deleted | null = null;
  #confirm: "delete" | "discard" | null = null;
  /** Set when Ctrl+C was pressed with unsaved text: a second one quits. */
  #quitArmed = false;
  #from: Screen = "home";

  constructor(env: TuiEnv) {
    this.env = env;
    this.roll = env.roll;
    this.reload();
    if (this.#draft()) this.say("You have an unsaved draft. Press Ctrl+O to pick it up.", "info");
  }

  reload(): void {
    const entries = this.roll.entries();
    this.#names = new Map<string, string>();
    this.#statusValue = null;
    this.#index = new SearchIndex(entries, { projectNames: this.#names });
    this.entries = entries;
    this.#tags = facets(entries).tags.map(([t]) => t);
    this.findIndex = Math.min(this.findIndex, Math.max(0, this.results().length - 1));
    this.homeIndex = Math.min(this.homeIndex, this.entries.length - 1);
  }

  say(message: string, tone: Tui["tone"] = "info"): void {
    this.message = message;
    this.tone = tone;
  }

  /** Entries matching the search, newest first. */
  results(): LoadedEntry[] {
    const q = this.find.value.trim();
    return q && this.#index ? this.#index.search(q) : this.entries;
  }

  /** How the Roll is doing: saved here, and whether that's backed up anywhere. */
  safety(): { text: string; tone: "ok" | "warn" | "none"; detail: string } {
    const s = this.#status();
    if (!s.remote) return { text: "on this computer only", tone: "none", detail: "This Roll isn't backed up yet. Quit and run: gitroll backup" };
    if (s.ahead) return { text: `saved · ${s.ahead} to back up`, tone: "warn", detail: `${s.ahead} ${s.ahead === 1 ? "entry is" : "entries are"} saved here but not backed up to ${s.remoteUrl}.` };
    if (s.dirty) return { text: "saved · file changes not committed", tone: "warn", detail: "Some files in the Roll folder were changed outside GitRoll." };
    return { text: "backed up", tone: "ok", detail: `Everything here is backed up to ${s.remoteUrl}.` };
  }

  /** Git's view of the Roll, asked for at most every couple of seconds: a key can't cost a git call. */
  #status(): SyncStatus {
    const now = Date.now();
    if (!this.#statusValue || now - this.#statusAt > 2000) {
      this.#statusValue = this.roll.status();
      this.#statusAt = now;
    }
    return this.#statusValue;
  }

  #draft(): Draft | null {
    try {
      return this.env.drafts?.load(this.roll.root) ?? null;
    } catch {
      return null;
    }
  }

  #context(): ComposerContext {
    return { projects: this.roll.projects(), tags: this.#tags };
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  async key(k: Key): Promise<void> {
    if (k.ctrl && k.name === "c") return this.#quit();
    this.#quitArmed = false;
    if (this.busy) return;
    if ((k.name !== undefined || k.ch !== undefined) && !this.#confirm) this.message = "";
    try {
      if (this.#confirm) return this.#answer(k);
      if (this.screen === "home") await this.#home(k);
      else if (this.screen === "compose") this.#compose(k);
      else if (this.screen === "find") await this.#search(k);
      else if (this.screen === "entry") this.#entry(k);
      else if (this.screen === "history") this.#scrollScreen(k, "historyScroll");
      else if (this.screen === "help") this.#scrollScreen(k, "helpScroll");
      else if (this.screen === "rolls") this.#rolls(k);
      else this.#topics(k);
    } catch (e) {
      this.busy = false;
      this.say(e instanceof UserError ? e.message : String((e as Error).message ?? e), "error");
    }
  }

  #quit(): void {
    if (this.composer?.dirty()) {
      this.#keepDraft();
      this.say("Your draft was kept. Press Ctrl+C again to quit.", "info");
      this.composer = null;
      this.screen = "home";
      return;
    }
    if (this.prompt.value.trim() && !this.#quitArmed) {
      this.#quitArmed = true;
      this.say("You have unsaved text in the prompt. Press Ctrl+C again to quit, or Enter to log it.", "error");
      return;
    }
    this.done = true;
  }

  #answer(k: Key): void {
    const what = this.#confirm;
    const yes = k.ch === "y" || k.ch === "Y" || (what === "discard" && k.name === "escape");
    this.#confirm = null;
    this.message = "";
    if (what === "delete") {
      if (!yes) return this.say("Kept it.");
      const entry = this.current!;
      this.roll.deleteEntry(entry.id);
      this.#deleted = { entry };
      this.reload();
      this.screen = this.#from === "find" ? "find" : "home";
      this.say("Deleted. Press Ctrl+Z to undo — it's still in this Roll's history.", "ok");
      return;
    }
    if (what === "discard") {
      if (!yes) return this.say("Still editing.");
      this.#keepDraft();
      this.composer = null;
      this.screen = "home";
      this.say("Draft kept. Press Ctrl+O to pick it up.", "info");
    }
  }

  #keepDraft(): void {
    const composer = this.composer;
    if (!composer || composer.empty()) return;
    try {
      this.env.drafts?.save(this.roll.root, composer.draft());
    } catch {
      // A draft that can't be written is not worth interrupting anyone over.
    }
  }

  // ── Home: the persistent prompt ───────────────────────────────────────────

  async #home(k: Key): Promise<void> {
    const menu = this.prompt.value.startsWith("/");
    if (menu) {
      const hits = matchCommands(this.prompt.value);
      if (k.name === "up" || k.name === "down") {
        this.menuIndex = Math.max(0, Math.min(hits.length - 1, this.menuIndex + (k.name === "down" ? 1 : -1)));
        return;
      }
      if (k.name === "tab") {
        if (hits[this.menuIndex]) this.prompt.set(`/${hits[this.menuIndex].name} `);
        return;
      }
      if (k.name === "return") {
        const chosen = hits[this.menuIndex] ?? hits[0];
        const rest = this.prompt.value.replace(/^\/\S*\s*/, "");
        this.prompt.clear();
        this.menuIndex = 0;
        if (!chosen) return this.say("No command by that name. Press / to see them all.", "error");
        return this.run(chosen.name, rest);
      }
      if (k.name === "escape") {
        this.prompt.clear();
        this.menuIndex = 0;
        return;
      }
      if (this.prompt.key(k)) this.menuIndex = 0;
      return;
    }
    if (k.ctrl && k.name === "o") return this.#openComposer("new");
    if (k.ctrl && k.name === "z") return this.#undo();
    if (k.ctrl && k.name === "r") return this.#refresh();
    switch (k.name) {
      case "up":
        if (this.entries.length) this.homeIndex = this.homeIndex < 0 ? 0 : Math.min(this.entries.length - 1, this.homeIndex + 1);
        return;
      case "down":
        this.homeIndex = this.homeIndex <= 0 ? -1 : this.homeIndex - 1;
        return;
      case "escape":
        if (this.prompt.value) this.prompt.clear();
        else this.homeIndex = -1;
        return;
      case "return": {
        if (this.prompt.value.trim()) return this.#quickLog();
        const chosen = this.entries[this.homeIndex];
        if (chosen) this.#openEntry(chosen, "home");
        else this.say("Type what happened, or press / for commands.");
        return;
      }
    }
    if (!this.prompt.value && k.ch === "?") {
      this.helpScroll = 0;
      return this.#go("help");
    }
    this.prompt.key(k);
  }

  #quickLog(): void {
    const text = this.prompt.value.trim();
    const { entry, notices } = this.roll.save({ text });
    this.prompt.clear();
    this.#quitArmed = false;
    this.reload();
    this.homeIndex = -1;
    this.say([`Logged. Saved here${this.#status().remote ? ", not backed up yet — /sync backs it up" : " on this computer"}.`, ...notices].join(" "), notices.length ? "error" : "ok");
    this.current = entry;
  }

  /** Runs a slash command. `rest` is whatever was typed after its name. */
  async run(name: string, rest = ""): Promise<void> {
    switch (name) {
      case "log":
        return this.#openComposer("new", rest.trim());
      case "find":
        if (rest.trim()) {
          this.find.set(rest.trim());
          this.findIndex = 0;
        }
        return this.#go("find");
      case "topics":
        this.topicIndex = 0;
        return this.#go("topics");
      case "roll":
        this.rollList = this.env.rolls();
        this.rollIndex = Math.max(0, this.rollList.findIndex((r) => r.path === this.roll.root));
        return this.#go("rolls");
      case "sync":
        return this.#sync();
      case "status": {
        const s = this.#status();
        const safety = this.safety();
        this.say(`${this.roll.config().name} · ${this.roll.root} · ${s.remoteUrl ?? "no backup"} · ${safety.detail}`, safety.tone === "ok" ? "ok" : "info");
        return;
      }
      case "undo":
        return this.#undo();
      case "web": {
        this.busy = true;
        this.say("Starting the browser app…");
        this.onChange?.();
        try {
          const url = await this.env.openInBrowser(this.roll);
          this.say(`Open in your browser while this stays running: ${url}`, "ok");
        } finally {
          this.busy = false;
        }
        return;
      }
      case "help":
        this.helpScroll = 0;
        return this.#go("help");
      case "quit":
        this.done = true;
        return;
      default:
        this.say(`There's no /${name} command. Press / to see them all.`, "error");
    }
  }

  #go(screen: Screen): void {
    this.#from = this.screen;
    this.screen = screen;
  }

  #back(): void {
    this.screen = this.#from === this.screen ? "home" : this.#from;
    this.#from = "home";
  }

  #refresh(): void {
    this.reload();
    this.say("Reloaded from the folder.");
  }

  #undo(): void {
    const gone = this.#deleted;
    if (!gone) return this.say("Nothing to undo.", "error");
    this.roll.restoreEntry(gone.entry);
    this.#deleted = null;
    this.reload();
    this.say("Restored.", "ok");
  }

  async #sync(): Promise<void> {
    const status = this.#status();
    if (!status.remote) {
      this.say("This Roll isn't backed up anywhere yet. Quit and run: gitroll backup", "error");
      return;
    }
    this.busy = true;
    this.say(`Syncing with ${status.remoteUrl}…`);
    this.onChange?.();
    try {
      const result = await this.roll.sync();
      this.reload();
      this.say(result.message, result.ok ? "ok" : "error");
    } finally {
      this.busy = false;
    }
  }

  // ── Composer ──────────────────────────────────────────────────────────────

  #openComposer(mode: ComposeMode, seed = ""): void {
    const draft = mode === "new" ? this.#draft() : null;
    this.composer = new Composer(this.#context(), draft ?? undefined);
    if (seed) {
      const text = this.composer.input("text");
      text.set(text.value ? `${text.value}\n${seed}` : seed);
    }
    this.composer.index = 0;
    this.#go("compose");
    if (draft) this.say("Picked up your unsaved draft.");
  }

  editEntry(entry: LoadedEntry, mode: ComposeMode): void {
    this.composer = Composer.forEntry(this.#context(), entry, mode);
    this.current = entry;
    this.#go("compose");
    this.say(mode === "edit" ? "Editing this entry. Ctrl+S saves it." : "A copy of this entry. Ctrl+S logs it as a new one.");
  }

  #compose(k: Key): void {
    const c = this.composer!;
    const fields = c.fields();
    if (k.ctrl && (k.name === "s" || k.name === "return")) return this.#saveCompose();
    if (k.ctrl && k.name === "e") return this.#externalEditor();
    if (k.name === "escape") {
      if (c.empty()) {
        this.env.drafts?.clear(this.roll.root);
        this.composer = null;
        this.#back();
        this.say("Nothing logged.");
      } else if (c.dirty()) {
        this.#confirm = "discard";
        this.say("Leave without saving? Your draft is kept. Press y to leave, any other key to keep editing.", "error");
      } else {
        this.#keepDraft();
        this.composer = null;
        this.#back();
        this.say("Draft kept. Press Ctrl+O to pick it up.");
      }
      return;
    }
    const move = (step: number) => {
      c.index = (c.index + step + fields.length) % fields.length;
      c.suggestions = [];
    };
    if (k.name === "tab") {
      if (c.suggestions.length) return c.key(k);
      return move(k.shift ? -1 : 1);
    }
    const field = c.field();
    const input = c.input(field.key);
    if ((k.name === "up" || k.name === "down") && !c.suggestions.length) {
      const atEdge = field.kind !== "multiline" || (k.name === "up" ? input.position().row === 0 : input.position().row === input.lines().length - 1);
      if (atEdge) return move(k.name === "down" ? 1 : -1);
    }
    if (k.name === "return" && field.kind !== "multiline") return move(1);
    c.key(k);
  }

  #externalEditor(): void {
    const c = this.composer!;
    if (!this.env.editExternally) return this.say("No editor is set. Set EDITOR or VISUAL to use one.", "error");
    const field = c.field();
    const key = field.kind === "multiline" ? field.key : "text";
    const input = c.input(key);
    const edited = this.env.editExternally(input.value);
    if (edited === null) return this.say("Your editor didn't change anything.");
    input.set(edited.replace(/\n+$/, ""));
    this.say("Brought your editor's text back in.", "ok");
  }

  #saveCompose(): void {
    const c = this.composer!;
    const files = parsePaths(c.value("files")).map((p) => this.env.readFile(p));
    if (!c.value("text").trim() && !files.length) {
      c.index = 0;
      throw new UserError("Type what happened, or add a file.");
    }
    const { entry, notices } = c.mode === "edit" ? this.roll.saveChanges(c.id!, c.toChanges(), files) : this.roll.save(c.toInput(), files);
    this.env.drafts?.clear(this.roll.root);
    this.composer = null;
    this.reload();
    this.current = entry;
    this.screen = this.#from === "find" || this.#from === "entry" ? this.#from : "home";
    this.#from = "home";
    const saved = c.mode === "edit" ? "Saved" : "Logged";
    this.say([`${saved}. Saved here${this.#status().remote ? ", not backed up yet — /sync backs it up" : " on this computer"}.`, ...notices].join(" "), notices.length ? "error" : "ok");
  }

  // ── Find ──────────────────────────────────────────────────────────────────

  async #search(k: Key): Promise<void> {
    const list = this.results();
    const chosen = list[this.findIndex];
    if (k.ctrl && k.name === "e" && chosen) return this.editEntry(chosen, "edit");
    if (k.ctrl && k.name === "k" && chosen) return this.editEntry(chosen, "duplicate");
    if (k.ctrl && k.name === "d" && chosen) return this.#askDelete(chosen, "find");
    switch (k.name) {
      case "escape":
        if (this.find.value) {
          this.find.clear();
          this.findIndex = 0;
          return;
        }
        this.#back();
        return;
      case "up":
        this.findIndex = Math.max(0, this.findIndex - 1);
        return;
      case "down":
        this.findIndex = Math.min(list.length - 1, this.findIndex + 1);
        return;
      case "pageup":
        this.findIndex = Math.max(0, this.findIndex - 10);
        return;
      case "pagedown":
        this.findIndex = Math.min(list.length - 1, this.findIndex + 10);
        return;
      case "return":
      case "right":
        if (chosen) this.#openEntry(chosen, "find");
        return;
    }
    if (this.find.key(k)) this.findIndex = 0;
  }

  // ── One entry ─────────────────────────────────────────────────────────────

  #openEntry(entry: LoadedEntry, from: Screen): void {
    this.current = entry;
    this.entryScroll = 0;
    this.attaching = null;
    this.#from = from;
    this.screen = "entry";
  }

  #askDelete(entry: LoadedEntry, from: Screen): void {
    this.current = entry;
    this.#from = from;
    this.#confirm = "delete";
    this.say("Delete this entry? It stays in the Roll's history. Press y to delete, any other key to keep it.", "error");
  }

  #entry(k: Key): void {
    const entry = this.current!;
    if (this.attaching) {
      if (k.name === "escape") {
        this.attaching = null;
        return this.say("Nothing attached.");
      }
      if (k.name === "return") {
        const paths = parsePaths(this.attaching.value);
        if (!paths.length) {
          this.attaching = null;
          return this.say("Nothing attached.");
        }
        const files = paths.map((p) => this.env.readFile(p));
        const { entry: next, notices } = this.roll.saveChanges(entry.path, {}, files);
        this.attaching = null;
        this.reload();
        this.current = next;
        return this.say([`Attached ${files.length} ${files.length === 1 ? "file" : "files"}.`, ...notices].join(" "), notices.length ? "error" : "ok");
      }
      this.attaching.key(k);
      return;
    }
    switch (k.name ?? k.ch) {
      case "escape":
      case "left":
      case "backspace":
      case "q":
        this.#back();
        return;
      case "up":
      case "k":
        this.entryScroll = Math.max(0, this.entryScroll - 1);
        return;
      case "down":
      case "j":
        this.entryScroll++;
        return;
      case "e":
        return this.editEntry(entry, "edit");
      case "y":
        return this.editEntry(entry, "duplicate");
      case "a":
        this.attaching = new Input();
        return this.say("Drag files here or type paths, then press Enter.");
      case "h":
        this.#history = this.roll.history(entry.id).map(({ date, author, subject }) => ({ date, author, subject }));
        this.historyScroll = 0;
        this.#from = "entry";
        this.screen = "history";
        return;
      case "d":
        return this.#askDelete(entry, this.#from);
    }
  }

  #scrollScreen(k: Key, key: "historyScroll" | "helpScroll"): void {
    switch (k.name ?? k.ch) {
      case "escape":
      case "left":
      case "backspace":
      case "q":
        return this.#back();
      case "up":
      case "k":
        this[key] = Math.max(0, this[key] - 1);
        return;
      case "down":
      case "j":
        this[key]++;
    }
  }

  #rolls(k: Key): void {
    switch (k.name ?? k.ch) {
      case "escape":
      case "q":
        return this.#back();
      case "up":
      case "k":
        this.rollIndex = Math.max(0, this.rollIndex - 1);
        return;
      case "down":
      case "j":
        this.rollIndex = Math.min(this.rollList.length - 1, this.rollIndex + 1);
        return;
      case "return": {
        const chosen = this.rollList[this.rollIndex];
        if (!chosen) return;
        this.#keepDraft();
        this.composer = null;
        this.roll = this.env.openRoll(chosen.path);
        this.env.rememberRoll?.(chosen.path);
        this.find.clear();
        this.findIndex = 0;
        this.homeIndex = -1;
        this.#deleted = null;
        this.reload();
        this.screen = "home";
        this.#from = "home";
        this.say(`Switched to ${this.roll.config().name}. It opens here next time.`, "ok");
      }
    }
  }

  /** Topics (stored as `projects`, exactly as the format describes) with how much is in each. */
  #topicRows(): { slug: string; name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const e of this.entries) for (const p of e.projects) counts.set(p, (counts.get(p) ?? 0) + 1);
    const rows = this.roll.projects().map((p) => ({ slug: p, name: p, count: counts.get(p) ?? 0 }));
    for (const [slug, count] of counts) if (!rows.some((r) => r.slug === slug)) rows.push({ slug, name: slug, count });
    return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  #topics(k: Key): void {
    const rows = this.#topicRows();
    switch (k.name ?? k.ch) {
      case "escape":
      case "q":
        return this.#back();
      case "up":
      case "k":
        this.topicIndex = Math.max(0, this.topicIndex - 1);
        return;
      case "down":
      case "j":
        this.topicIndex = Math.min(rows.length - 1, this.topicIndex + 1);
        return;
      case "return": {
        const chosen = rows[this.topicIndex];
        if (!chosen) return;
        this.find.set(`topic:${chosen.slug}`);
        this.findIndex = 0;
        this.screen = "find";
        this.#from = "home";
      }
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  render(w0: number, h0: number): string[] {
    const w = Math.max(24, w0);
    const h = Math.max(10, h0);
    const chrome = this.screen === "home" ? 5 : 4;
    const body =
      this.screen === "home"
        ? this.#drawHome(w, h - chrome)
        : this.screen === "compose"
          ? this.#drawCompose(w, h - chrome)
          : this.screen === "find"
            ? this.#drawFind(w, h - chrome)
            : this.screen === "entry"
              ? this.#drawEntry(w, h - chrome)
              : this.screen === "history"
                ? this.#drawHistory(w, h - chrome)
                : this.screen === "help"
                  ? this.#drawHelp(w, h - chrome)
                  : this.screen === "rolls"
                    ? this.#drawRolls(w, h - chrome)
                    : this.#drawTopics(w, h - chrome);
    const lines = [this.#header(w), dim("─".repeat(w)), ...body.slice(0, h - chrome)];
    while (lines.length < h - (chrome - 2)) lines.push("");
    if (this.screen === "home") lines.push(this.#promptLine(w));
    const paint = this.tone === "ok" ? green : this.tone === "error" ? red : dim;
    lines.push(this.message ? paint(fit(` ${this.message}`, w)) : "");
    lines.push(dim(fit(` ${this.#keys()}`, w)));
    return lines;
  }

  #header(w: number): string {
    const safety = this.safety();
    const paint = safety.tone === "ok" ? green : safety.tone === "warn" ? yellow : dim;
    const where = this.#status().remoteUrl ?? this.roll.root;
    const left = `${bold(` GitRoll · ${clean(this.roll.config().name)}`)}${dim(`  ${where}`)}`;
    return spread(left, paint(safety.text), w);
  }

  #promptLine(w: number): string {
    const label = this.prompt.value.startsWith("/") ? cyan(" › ") : " › ";
    const room = w - 4;
    if (!this.prompt.value) return `${label}${dim(fit("What happened? Type it here, or press / for commands", room))}`;
    return `${label}${caret(this.prompt.value, this.prompt.cursor, room)}`;
  }

  #keys(): string {
    if (this.#confirm) return "y confirms · any other key cancels";
    if (this.busy) return "working…";
    switch (this.screen) {
      case "home":
        return this.prompt.value.startsWith("/") ? "↑↓ choose · Tab complete · Enter run · Esc cancel" : "Enter log · / commands · ↑↓ pick an entry · Ctrl+O composer · Ctrl+Z undo · ? help";
      case "compose":
        return "Tab/↑↓ fields · Ctrl+S save · Ctrl+E editor · Esc back (draft kept)";
      case "find":
        return "type to search · ↑↓ choose · Enter open · Ctrl+E edit · Ctrl+K duplicate · Ctrl+D delete · Esc back";
      case "entry":
        return this.attaching ? "type or drag paths · Enter attach · Esc cancel" : "e edit · y duplicate · a attach · h history · d delete · ↑↓ scroll · Esc back";
      case "history":
        return "↑↓ scroll · Esc back";
      case "rolls":
        return "↑↓ choose · Enter switch · Esc back";
      case "topics":
        return "↑↓ choose · Enter find its entries · Esc back";
      default:
        return "↑↓ scroll · Esc back";
    }
  }

  /** One entry as a timeline row: date, first line, and its labels on the right. */
  #row(e: LoadedEntry, w: number): string {
    const labels = [...e.projects.map((p) => this.#names.get(p) ?? p), e.attachments.length ? `${e.attachments.length} file${e.attachments.length === 1 ? "" : "s"}` : "", e.amount ? `${e.amount.value} ${e.amount.currency}` : ""]
      .filter(Boolean)
      .join(" · ");
    const date = day(e.date).padEnd(7);
    const room = Math.max(8, w - 4 - date.length - (labels ? labels.length + 2 : 0));
    const text = `${date} ${fit(e.title || "(no text)", room)}`;
    return labels ? `${pad(text, Math.max(0, w - 3 - labels.length))} ${clean(labels)}` : text;
  }

  #list(rows: string[], selected: number, scroll: number, w: number, height: number): { lines: string[]; scroll: number } {
    let at = scroll;
    if (selected >= 0 && selected < at) at = selected;
    if (selected >= at + height) at = selected - height + 1;
    at = Math.max(0, Math.min(at, Math.max(0, rows.length - height)));
    const lines = rows.slice(at, at + height).map((row, i) => (at + i === selected ? inverse(pad(fit(`▸ ${row}`, w), w)) : `  ${fit(row, w - 2)}`));
    return { lines, scroll: at };
  }

  #drawHome(w: number, rows: number): string[] {
    if (this.prompt.value.startsWith("/")) return this.#drawMenu(w, rows);
    if (!this.entries.length) {
      const blurb = [dim("  Nothing logged yet."), "", dim("  Type what happened below and press Enter."), dim("  Press / for commands, or Ctrl+O for the full composer.")];
      return [...Array(Math.max(0, rows - blurb.length)).fill(""), ...blurb];
    }
    // Newest last, so the most recent entry sits right above the prompt.
    const lines = this.entries.map((e) => this.#row(e, w)).reverse();
    const selected = this.homeIndex >= 0 ? lines.length - 1 - Math.min(this.homeIndex, lines.length - 1) : -1;
    const bottom = Math.max(0, lines.length - rows);
    const { lines: shown, scroll } = this.#list(lines, selected, this.homeScroll ?? bottom, w, rows);
    this.homeScroll = selected < 0 ? bottom : scroll;
    // Keep the newest entry right above the prompt, even when there are only a few.
    return [...Array(Math.max(0, rows - shown.length)).fill(""), ...shown];
  }

  #drawMenu(w: number, rows: number): string[] {
    const hits = matchCommands(this.prompt.value);
    this.menuIndex = Math.max(0, Math.min(this.menuIndex, hits.length - 1));
    if (!hits.length) return [dim("  No command by that name. Press Esc to go back to writing.")];
    const nameWidth = Math.max(...hits.map((c) => c.name.length)) + 2;
    const lines = hits.map((c) => `${`/${c.name}`.padEnd(nameWidth + 1)}${c.summary}`);
    return [bold(" Commands"), ...this.#list(lines, this.menuIndex, 0, w, Math.max(1, rows - 1)).lines];
  }

  #drawFind(w: number, rows: number): string[] {
    const list = this.results();
    this.findIndex = Math.max(0, Math.min(this.findIndex, list.length - 1));
    const head = [` Find: ${caret(this.find.value, this.find.cursor, w - 9)}`, dim(fit(`  ${list.length} of ${this.entries.length} · filters: topic: tag: type: after: before: amount:>100 has:photo`, w))];
    if (!list.length) return [...head, "", dim("  Nothing found. Try fewer words, or Esc to clear the search.")];
    const side = w >= 100;
    const listWidth = side ? Math.floor(w * 0.52) : w;
    const height = rows - head.length;
    const { lines, scroll } = this.#list(list.map((e) => this.#row(e, listWidth)), this.findIndex, this.findScroll, listWidth, height);
    this.findScroll = scroll;
    if (!side) return [...head, ...lines, ...(list[this.findIndex] ? [dim("─".repeat(w)), ...this.#preview(list[this.findIndex], w, 3)] : [])];
    const preview = this.#preview(list[this.findIndex], w - listWidth - 3, height);
    const body = Array.from({ length: height }, (_, i) => `${pad(lines[i] ?? "", listWidth)} ${dim("│")} ${preview[i] ?? ""}`);
    return [...head, ...body];
  }

  /** A short read-only look at an entry, for the side of the search screen. */
  #preview(e: LoadedEntry | undefined, w: number, rows: number): string[] {
    if (!e) return [];
    const out = [bold(fit(when(e.date), w)), ...(e.projects.length ? [dim(fit(e.projects.map((p) => this.#names.get(p) ?? p).join(" · "), w))] : []), ""];
    for (const l of wrap(e.body || "(no text)", w)) out.push(fit(l, w));
    if (e.amount) out.push(dim(fit(`Amount: ${e.amount.value} ${e.amount.currency}`, w)));
    if (e.tags.length) out.push(dim(fit(e.tags.map((t) => `#${t}`).join(" "), w)));
    for (const a of e.attachments) out.push(dim(fit(`File: ${a.name}`, w)));
    return out.slice(0, rows);
  }

  #drawEntry(w: number, rows: number): string[] {
    const e = this.current!;
    const meta = e.projects.map((p) => this.#names.get(p) ?? p).join(" · ");
    const lines = [` ${bold(when(e.date))}${meta ? `  ${clean(meta)}` : ""}`, ""];
    for (const l of wrap(e.body || "(no text)", w - 2)) lines.push(` ${l}`);
    lines.push("");
    if (e.amount) lines.push(dim(` Amount: ${e.amount.value} ${e.amount.currency}`));
    if (e.tags.length) lines.push(dim(` Tags: ${e.tags.map((t) => `#${t}`).join(" ")}`));
    for (const a of e.attachments) lines.push(dim(fit(` File: ${a.name}`, w)));
    for (const [k, v] of Object.entries(e.meta)) {
      if (["projects", "tags", "amount", "currency", "date", "title"].includes(k)) continue;
      lines.push(dim(fit(` ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`, w)));
    }
    lines.push(dim(fit(` ${e.path}`, w)));
    if (this.attaching) lines.push("", ` Attach: ${caret(this.attaching.value, this.attaching.cursor, w - 10)}`);
    this.entryScroll = Math.min(this.entryScroll, Math.max(0, lines.length - rows));
    return lines.slice(this.entryScroll);
  }

  #drawHistory(w: number, rows: number): string[] {
    const lines = [bold(` Every change to this entry`), ""];
    if (!this.#history.length) lines.push(dim("  No history yet — it hasn't been committed."));
    for (const h of this.#history) lines.push(fit(`  ${when(h.date)}  ${h.author}  ${h.subject}`, w));
    this.historyScroll = Math.min(this.historyScroll, Math.max(0, lines.length - rows));
    return lines.slice(this.historyScroll);
  }

  #drawRolls(w: number, rows: number): string[] {
    if (!this.rollList.length) return [dim('  No Rolls yet. Quit and run: gitroll new "Name"')];
    const lines = this.rollList.map((r) => `${r.name}${r.path === this.roll.root ? "  (open)" : ""}   ${r.path}`);
    return [bold(" Your Rolls"), "", ...this.#list(lines, this.rollIndex, 0, w, Math.max(1, rows - 2)).lines];
  }

  #drawTopics(w: number, rows: number): string[] {
    const topics = this.#topicRows();
    if (!topics.length) return [dim("  No topics yet. Add one to an entry in the composer and GitRoll creates it.")];
    this.topicIndex = Math.max(0, Math.min(this.topicIndex, topics.length - 1));
    const lines = topics.map((t) => `${t.name.padEnd(28)}${t.count} ${t.count === 1 ? "entry" : "entries"}`);
    return [bold(" Topics"), "", ...this.#list(lines, this.topicIndex, 0, w, Math.max(1, rows - 2)).lines];
  }

  #drawCompose(w: number, rows: number): string[] {
    const c = this.composer!;
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

  #drawHelp(w: number, rows: number): string[] {
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
      "   Words match anywhere. Filters can be combined:",
      "   topic:house  tag:payment  type:expense  after:2026-01-01  before:2026-06-30",
      "   amount:>500  has:photo  has:receipt  by:jimmy",
      "",
      bold(" Your entries"),
      `   This Roll lives in ${this.roll.root}`,
      "   Every entry is a Markdown file in a Git repository you own.",
      "   Nothing leaves this computer until you back it up with /sync.",
    ].map((l) => fit(l, w));
    this.helpScroll = Math.min(this.helpScroll, Math.max(0, lines.length - rows));
    return lines.slice(this.helpScroll);
  }
}

// ── Terminal ────────────────────────────────────────────────────────────────

export function tuiSupported(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && process.env.TERM !== "dumb";
}

const NAMED = ["up", "down", "left", "right", "return", "enter", "escape", "backspace", "delete", "tab", "home", "end", "pageup", "pagedown"];

/** Turns a Node keypress into the app's key, so the model never sees terminal details. */
export function toKey(str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } = {}): Key {
  if (key.name && (NAMED.includes(key.name) || key.ctrl)) {
    return { name: key.name === "enter" ? "return" : key.name, ctrl: key.ctrl, shift: key.shift };
  }
  return str && !key.ctrl && !key.meta ? { ch: str } : {};
}

export async function runTui(env: TuiEnv): Promise<void> {
  const tui = new Tui(env);
  const out = process.stdout;
  const draw = () => {
    const lines = tui.render(out.columns || 80, out.rows || 24);
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
      const onKey = (str: string | undefined, key: Parameters<typeof toKey>[1] = {}) => {
        const k = toKey(str, key);
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
