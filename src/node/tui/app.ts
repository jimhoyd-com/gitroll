// GitRoll's interactive workspace: a persistent prompt with recent entries above
// it, a "/" command menu, a full entry composer and a live search.
//
// `Tui` is a plain model (keys in, lines out) so every behavior is testable
// without a terminal; `runTui` connects it to a real one. No dependencies.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { LoadedEntry, Problem } from "../../core/layout.ts";
import { SearchIndex, facets } from "../../core/search.ts";
import { ConflictError, UserError, titleCase } from "../../core/util.ts";
import { describeBlocker } from "../repo.ts";
import type { DeletedEntry, FileInput, GitRoll, SyncStatus } from "../repo.ts";
import { Composer } from "./compose.ts";
import type { ComposeMode, ComposerContext, Draft } from "./compose.ts";
import { Input, dim, fit, parsePaths, shorten } from "./text.ts";
import type { Key } from "./text.ts";
import { header, message, promptLine, rule } from "./screens/chrome.ts";
import type { Names } from "./screens/chrome.ts";
import { composerView } from "./screens/composer.ts";
import { entry, history } from "./screens/entry.ts";
import { find } from "./screens/find.ts";
import { help } from "./screens/help.ts";
import { deleted, problems, rolls, topics } from "./screens/lists.ts";
import { menu, timeline } from "./screens/timeline.ts";
import { matchCommands } from "./commands.ts";

export type { Key } from "./text.ts";
export { COMMANDS, matchCommands } from "./commands.ts";
export type { Command } from "./commands.ts";
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
  /** Opens one of the Roll's files in the person's own editor. */
  editFile?(rollRoot: string, relativePath: string): void;
  /** Opens an attachment in whatever application normally opens it. */
  openFile?(absolutePath: string): void;
}

type Screen = "home" | "compose" | "find" | "entry" | "history" | "rolls" | "topics" | "problems" | "deleted" | "help";

interface Deleted {
  entry: LoadedEntry;
  /** The file as it was, so undo puts back every part of it. */
  source: string;
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
  /** Files under entries/ that don't parse. Their writing is still on disk. */
  problems: Problem[] = [];
  problemIndex = 0;
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
  /** Which of the event's files the keys act on. */
  attachIndex = 0;
  deletedList: DeletedEntry[] = [];
  deletedIndex = 0;
  attaching: Input | null = null;
  historyScroll = 0;
  #history: { date: string; author: string; subject: string }[] = [];

  composer: Composer | null = null;
  /** The entry's file as it was when the composer opened, so an editor's save isn't clobbered. */
  #editBase: string | null = null;
  rollList: { key: string; name: string; path: string }[] = [];
  rollIndex = 0;
  topicIndex = 0;
  helpScroll = 0;

  #deleted: Deleted | null = null;
  #confirm: "delete" | "discard" | "overwrite" | null = null;
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
    // Files that can't be read come back with the entries, so the workspace can
    // name them rather than drop them. Projects are just words in the new format,
    // and there are no type definitions to register.
    const { entries, problems } = this.roll.load();
    this.problems = problems;
    // Topics are stored as slugs and have no name of their own to store, so the
    // name is made from the slug: bathroom-remodel reads as Bathroom Remodel.
    this.#names = new Map(this.roll.projects().map((slug) => [slug, titleCase(slug)]));
    this.#statusValue = null;
    this.#index = new SearchIndex(entries, { projectNames: this.#names });
    this.entries = entries;
    this.#tags = facets(entries).tags.map(([t]) => t);
    this.problemIndex = Math.min(this.problemIndex, Math.max(0, problems.length - 1));
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

  /**
   * Three states, kept apart on purpose: written to the folder, recorded by Git,
   * and arrived at the backup. Logging does the first two together; only /sync
   * does the third.
   */
  safety(): { text: string; tone: "ok" | "warn" | "none"; detail: string } {
    const s = this.#status();
    if (s.blocker) return { text: "needs a hand", tone: "warn", detail: describeBlocker(s.blocker) };
    const parts: string[] = [];
    if (s.uncommitted) parts.push(`${s.uncommitted} not committed`);
    if (!s.remote) parts.push("not backed up");
    else if (s.ahead) parts.push(`${s.ahead} to back up`);
    if (!parts.length) return { text: "backed up", tone: "ok", detail: `Everything here is saved, committed and backed up to ${s.remoteUrl}.` };
    const detail = [
      s.uncommitted ? `${s.uncommitted} ${s.uncommitted === 1 ? "file was" : "files were"} changed in the folder without being committed.` : "",
      !s.remote ? "This Roll isn't backed up anywhere yet. Quit and run: gitroll backup" : s.ahead ? `${s.ahead} ${s.ahead === 1 ? "change is" : "changes are"} saved and committed here but not yet at ${s.remoteUrl}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { text: `saved · ${parts.join(" · ")}`, tone: s.remote ? "warn" : "none", detail };
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
      else if (this.screen === "problems") this.#problems(k);
      else if (this.screen === "deleted") this.#deletedScreen(k);
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
      this.#deleted = { entry, source: this.roll.deleteEntry(entry.id) };
      this.reload();
      // Deleting from the list of results keeps the list: someone working
      // through a search shouldn't be thrown out of it on every one.
      this.screen = this.#from === "find" ? "find" : "home";
      this.say("Deleted. Press Ctrl+Z to undo — it's still in this Roll's history.", "ok");
      return;
    }
    if (what === "overwrite") {
      if (!yes) return this.say("Still editing. Ctrl+R shows what changed on disk.");
      this.#saveCompose(true);
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
    if (k.ch === "/" && !this.find.value) return this.#commandsFromHere();
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
    this.say([`Logged to ${entry.path}.${this.#status().remote ? " Committed here, not backed up yet — /sync does that." : " Committed on this computer."}`, ...notices].join(" "), notices.length ? "error" : "ok");
    this.current = entry;
  }

  /** Runs a slash command. `rest` is whatever was typed after its name. */
  async run(name: string, rest = ""): Promise<void> {
    switch (name) {
      case "log":
        return this.#openComposer("new", rest.trim());
      case "find":
        // Running /find starts a search, so the box starts empty. It used to
        // keep the last query, which meant the next thing typed landed on the
        // end of it and found nothing. Coming back to the screen another way —
        // Esc out of an event, saving from the composer — still lands on the
        // search you left.
        this.find.set(rest.trim());
        this.findIndex = 0;
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
        const where = `${this.roll.config().name} · ${shorten(this.roll.root)} · ${s.branch || "detached HEAD"} · ${s.remoteUrl ?? "no backup"}`;
        this.say(`${where} · ${safety.detail}`, safety.tone === "ok" ? "ok" : "info");
        return;
      }
      case "undo":
        return this.#undo();
      case "problems":
        this.problemIndex = 0;
        return this.#go("problems");
      case "deleted":
        this.deletedList = this.roll.deleted();
        this.deletedIndex = 0;
        return this.#go("deleted");
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

  /**
   * "/" means commands, everywhere it can't mean text. The menu lives at the
   * prompt, so this goes back there and opens it: one place, one habit, rather
   * than a different answer on every screen.
   */
  #commandsFromHere(): void {
    this.screen = "home";
    this.#from = "home";
    this.prompt.set("/");
    this.menuIndex = 0;
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

  /**
   * The folder changed under us — someone edited a file, or `gitroll log` ran in
   * another window. Take it, and say so only when it changed what's on screen.
   * Never while the composer is open: that would move the ground mid-sentence.
   */
  externalChange(): boolean {
    if (this.busy || this.screen === "compose" || this.#confirm) return false;
    const before = { entries: this.entries.length, problems: this.problems.length };
    this.reload();
    if (this.problems.length > before.problems) this.say("A file changed outside GitRoll, and GitRoll can't read it — /problems.", "error");
    else if (this.problems.length < before.problems) this.say(this.problems.length ? "One of those files reads cleanly again." : "That file reads cleanly again.", "ok");
    else if (this.entries.length !== before.entries) this.say("Picked up a change made outside GitRoll.");
    return true;
  }

  #undo(): void {
    const gone = this.#deleted;
    if (!gone) return this.say("Nothing to undo.", "error");
    this.roll.restoreEntry(gone.entry, gone.source);
    this.#deleted = null;
    this.reload();
    this.say("Restored.", "ok");
  }

  async #sync(): Promise<void> {
    const status = this.#status();
    // The more specific state first: "not backed up" is true of a detached HEAD
    // too, and it isn't the thing standing in the way.
    if (status.blocker) return this.say(describeBlocker(status.blocker), "error");
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
    this.#editBase = null;
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
    this.#editBase = mode === "edit" ? this.roll.fingerprint(entry.id) : null;
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

  #saveCompose(force = false): void {
    const c = this.composer!;
    const files = parsePaths(c.value("files")).map((p) => this.env.readFile(p));
    if (!c.value("text").trim() && !files.length) {
      c.index = 0;
      throw new UserError("Type what happened, or add a file.");
    }
    let saved: { entry: LoadedEntry; notices: string[] };
    try {
      saved = c.mode === "edit" ? this.roll.saveChanges(c.id!, c.toChanges(), files, { expect: force ? undefined : (this.#editBase ?? undefined) }) : this.roll.save(c.toInput(), files);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      // Their editor got there first. Nothing is written until someone chooses.
      this.#confirm = "overwrite";
      this.say("This entry changed on disk since you opened it. Press y to save yours over it, or any other key to keep editing — Esc keeps your draft.", "error");
      return;
    }
    const { entry, notices } = saved;
    this.env.drafts?.clear(this.roll.root);
    this.composer = null;
    this.reload();
    this.current = entry;
    this.screen = this.#from === "find" || this.#from === "entry" ? this.#from : "home";
    // Landing back on the timeline lands on the prompt, the way logging from
    // the prompt does. The marker was left on whatever was picked before the
    // composer opened — not what was just written — and Enter on it would open
    // that entry instead of logging the next thing.
    if (this.screen === "home") this.homeIndex = -1;
    this.#from = "home";
    const what = c.mode === "edit" ? "Saved" : "Logged";
    const copied = files.length ? ` ${files.length} ${files.length === 1 ? "file" : "files"} copied into the Roll and linked from it.` : "";
    this.say([`${what} to ${entry.path}.${copied}${this.#status().remote ? " Committed here, not backed up yet — /sync does that." : " Committed on this computer."}`, ...notices].join(" "), notices.length ? "error" : "ok");
  }

  // ── Find ──────────────────────────────────────────────────────────────────

  async #search(k: Key): Promise<void> {
    const list = this.results();
    const chosen = list[this.findIndex];
    // Finding nothing is a reason to write something down, so the composer is
    // here too; saving comes back to the search you were in.
    if (k.ctrl && k.name === "o") return this.#openComposer("new");
    if (k.ch === "/" && !this.find.value) return this.#commandsFromHere();
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
    this.attachIndex = 0;
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
    if (k.ch === "/" && !this.attaching) return this.#commandsFromHere();
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
        return this.say([`Copied ${files.length} ${files.length === 1 ? "file" : "files"} into the Roll and linked ${files.length === 1 ? "it" : "them"} from this event. The originals are untouched.`, ...notices].join(" "), notices.length ? "error" : "ok");
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
        return this.say("Drag files here or type paths, then press Enter. GitRoll copies them into the Roll.");
      case "tab":
        if (entry.attachments.length > 1) this.attachIndex = (this.attachIndex + 1) % entry.attachments.length;
        return;
      case "o": {
        const file = entry.attachments[this.attachIndex];
        if (!file) return this.say("This event has no files.");
        const where = this.roll.attachmentFile(file.path);
        if (!where) return this.say(`${file.name} is linked from this event, but ${file.path} isn't in the Roll. It may not have been synced yet.`, "error");
        if (!this.env.openFile) return this.say(`It's at ${where}`, "info");
        this.env.openFile(where);
        return this.say(`Opened ${file.name}.`, "ok");
      }
      case "h":
        this.#history = this.roll.history(entry.id).map(({ date, author, subject }) => ({ date, author, subject }));
        this.historyScroll = 0;
        this.#from = "entry";
        this.screen = "history";
        return;
      case "d":
        // Back to the timeline, not to whatever search led here: that search no
        // longer matches what was just deleted, and the timeline is where undo
        // and the commands are.
        return this.#askDelete(entry, "home");
    }
  }

  #scrollScreen(k: Key, key: "historyScroll" | "helpScroll"): void {
    if (k.ch === "/") return this.#commandsFromHere();
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
    if (k.ch === "/") return this.#commandsFromHere();
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
        this.say(`Switched to ${this.roll.config().name} · ${shorten(this.roll.root)} · opens here next time.`, "ok");
      }
    }
  }

  /** Topics (stored as `projects`, exactly as the format describes) with how much is in each. */
  /**
   * Files under entries/ that don't parse. GitRoll never rewrites them and never
   * drops them: the writing stays exactly where its author left it, and this is
   * where they find out which line to fix.
   */
  /** Deleted events, read back out of Git history. Putting one back is a new change, never a rewrite. */
  #deletedScreen(k: Key): void {
    if (k.ch === "/") return this.#commandsFromHere();
    switch (k.name ?? k.ch) {
      case "escape":
      case "q":
        return this.#back();
      case "up":
      case "k":
        this.deletedIndex = Math.max(0, this.deletedIndex - 1);
        return;
      case "down":
      case "j":
        this.deletedIndex = Math.min(this.deletedList.length - 1, this.deletedIndex + 1);
        return;
      case "return":
      case "r": {
        const chosen = this.deletedList[this.deletedIndex];
        if (!chosen) return;
        // The file's own text, so what comes back is what was written.
        const back = this.roll.restoreEntry(chosen.entry, chosen.source);
        this.deletedList = this.roll.deleted();
        this.deletedIndex = Math.max(0, Math.min(this.deletedIndex, this.deletedList.length - 1));
        this.reload();
        this.say(`Put back as ${back.path}. That's a new change — the deletion is still in the history.`, "ok");
      }
    }
  }

  #problems(k: Key): void {
    if (k.ch === "/") return this.#commandsFromHere();
    switch (k.name ?? k.ch) {
      case "escape":
      case "q":
        return this.#back();
      case "up":
      case "k":
        this.problemIndex = Math.max(0, this.problemIndex - 1);
        return;
      case "down":
      case "j":
        this.problemIndex = Math.min(this.problems.length - 1, this.problemIndex + 1);
        return;
      case "r":
        return this.#refresh();
      case "return":
      case "e": {
        const chosen = this.problems[this.problemIndex];
        if (!chosen?.path) return;
        if (!this.env.editFile) return this.say("Set EDITOR (or VISUAL) to open this file here.", "error");
        this.env.editFile(this.roll.root, chosen.path);
        this.reload();
        this.say(this.problems.length ? "Still unreadable. Nothing in the file was changed by GitRoll." : "That's readable now.", this.problems.length ? "error" : "ok");
      }
    }
  }

  #topicRows(): { slug: string; name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const e of this.entries) for (const p of e.projects) counts.set(p, (counts.get(p) ?? 0) + 1);
    const rows = this.roll.projects().map((p) => ({ slug: p, name: titleCase(p), count: counts.get(p) ?? 0 }));
    for (const [slug, count] of counts) if (!rows.some((r) => r.slug === slug)) rows.push({ slug, name: slug, count });
    return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  #topics(k: Key): void {
    if (k.ch === "/") return this.#commandsFromHere();
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

  /**
   * The whole screen, from the state above. Drawing lives in ./screens: each one
   * is a function of what it shows, so the app decides what is true and the
   * screens only decide how it looks.
   */
  render(w0: number, h0: number): string[] {
    const w = Math.max(24, w0);
    const h = Math.max(10, h0);
    const said = message(this.message, this.tone, w);
    const chrome = (this.screen === "home" ? 4 : 3) + said.length;
    const rows = h - chrome;
    const names: Names = (slug) => this.#names.get(slug) ?? titleCase(slug);
    let body: string[];
    if (this.screen === "home") {
      if (this.prompt.value.startsWith("/")) {
        const matches = matchCommands(this.prompt.value);
        this.menuIndex = Math.max(0, Math.min(this.menuIndex, matches.length - 1));
        body = menu({ matches, index: this.menuIndex, width: w, rows });
      } else {
        const drawn = timeline({ entries: this.entries, selected: this.homeIndex, scroll: this.homeScroll, names, width: w, rows });
        this.homeScroll = drawn.scroll;
        body = drawn.lines;
      }
    } else if (this.screen === "compose") {
      body = composerView(this.composer!, w, rows);
    } else if (this.screen === "find") {
      const results = this.results();
      this.findIndex = Math.max(0, Math.min(this.findIndex, results.length - 1));
      const drawn = find({ query: this.find, results, total: this.entries.length, selected: this.findIndex, scroll: this.findScroll, names, width: w, rows });
      this.findScroll = drawn.scroll;
      body = drawn.lines;
    } else if (this.screen === "entry") {
      const drawn = entry({
        entry: this.current!,
        names,
        hasFile: (rel) => this.roll.attachmentFile(rel) !== null,
        attachIndex: this.attachIndex,
        attaching: this.attaching,
        scroll: this.entryScroll,
        width: w,
        rows,
      });
      this.entryScroll = drawn.scroll;
      body = drawn.lines;
    } else if (this.screen === "history") {
      const drawn = history(this.#history, this.historyScroll, w, rows);
      this.historyScroll = drawn.scroll;
      body = drawn.lines;
    } else if (this.screen === "help") {
      const drawn = help(this.roll.root, this.helpScroll, w, rows);
      this.helpScroll = drawn.scroll;
      body = drawn.lines;
    } else if (this.screen === "rolls") {
      body = rolls(this.rollList, this.roll.root, this.rollIndex, w, rows);
    } else if (this.screen === "problems") {
      this.problemIndex = Math.max(0, Math.min(this.problemIndex, this.problems.length - 1));
      body = problems(this.problems, this.problemIndex, w, rows);
    } else if (this.screen === "deleted") {
      this.deletedIndex = Math.max(0, Math.min(this.deletedIndex, this.deletedList.length - 1));
      body = deleted(this.deletedList, this.deletedIndex, w, rows, names);
    } else {
      const found = this.#topicRows();
      this.topicIndex = Math.max(0, Math.min(this.topicIndex, found.length - 1));
      body = topics(found, this.topicIndex, w, rows);
    }
    const lines = [
      header(this.roll.config().name, this.roll.root, this.#status(), this.safety(), w),
      rule(this.screen === "problems" ? 0 : this.problems.length, w),
      ...body.slice(0, rows),
    ];
    while (lines.length < h - said.length - (this.screen === "home" ? 2 : 1)) lines.push("");
    if (this.screen === "home") lines.push(promptLine(this.prompt, w));
    lines.push(...said);
    lines.push(dim(fit(` ${this.#keys()}`, w)));
    return lines;
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
        return "type to search · ↑↓ choose · Enter open · Ctrl+O new · Ctrl+E edit · Ctrl+K copy · Ctrl+D delete · Esc back";
      case "entry":
        return this.attaching
          ? "type or drag paths · Enter attach · Esc cancel"
          : this.current?.attachments.length
            ? "e edit · y duplicate · a attach · o open file · Tab next file · h history · d delete · Esc back"
            : "e edit · y duplicate · a attach · h history · d delete · ↑↓ scroll · Esc back";
      case "history":
        return "↑↓ scroll · Esc back";
      case "rolls":
        return "↑↓ choose · Enter switch · Esc back";
      case "topics":
        return "↑↓ choose · Enter find its entries · Esc back";
      case "problems":
        return "↑↓ choose · Enter open it in your editor · Ctrl+R re-read · Esc back";
      case "deleted":
        return "↑↓ choose · Enter put it back · Esc back";
      default:
        return "↑↓ scroll · Esc back";
    }
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

/** What the Roll's files look like right now: enough to notice any edit, cheaply. */
function rollSignature(root: string): string {
  // FNV-1a over name, size and modification time. A hash rather than the list
  // itself, so a Roll with thousands of entries costs one number, not a string.
  let hash = 0x811c9dc5;
  const add = (text: string) => {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  };
  for (const folder of ["entries", "projects", ".gitroll"]) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, folder), { recursive: true }).map(String);
    } catch {
      continue; // A Roll needn't have every folder.
    }
    for (const name of names.sort()) {
      try {
        const st = fs.statSync(path.join(root, folder, name));
        if (st.isFile()) add(`${folder}/${name}:${st.size}:${st.mtimeMs}`);
      } catch {
        // A file that vanished mid-walk is itself a change; the next pass sees it.
      }
    }
  }
  return String(hash >>> 0);
}

/**
 * Watches a Roll's folder for changes made anywhere else — an editor, another
 * terminal — and calls back once things settle.
 *
 * Two mechanisms on purpose. `fs.watch` is instant, but recursive watching is
 * unreliable: on Linux it has been seen registering only part of a tree, so
 * edits under `entries/` arrive for some folders and never for others. The slow
 * pass over the file list is the one that guarantees the change is noticed, and
 * it costs a few stat calls every couple of seconds.
 */
export function watchRoll(root: string, onChange: () => void, everyMs = 2000): () => void {
  let signature = rollSignature(root);
  const check = () => {
    const next = rollSignature(root);
    if (next === signature) return;
    signature = next;
    onChange();
  };
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(check, 150);
  };
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      const rel = name ? String(name) : "";
      if (!rel.startsWith(".git/") && !rel.startsWith(".git\\") && rel !== ".git") soon();
    });
    watcher.on("error", () => {});
  } catch {
    // Watching is a convenience; the pass below is what makes this work anyway.
  }
  const timer = setInterval(check, everyMs);
  timer.unref?.();
  return () => {
    if (debounce) clearTimeout(debounce);
    clearInterval(timer);
    watcher?.close();
  };
}

export async function runTui(env: TuiEnv): Promise<void> {
  const tui = new Tui(env);
  const out = process.stdout;
  const draw = () => {
    const lines = tui.render(out.columns || 80, out.rows || 24);
    out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J`);
  };
  tui.onChange = draw;
  let unwatch = watchRoll(tui.roll.root, () => {
    if (tui.externalChange()) draw();
  });
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
          const watching = tui.roll.root;
          await tui.key(k);
          if (tui.roll.root !== watching) {
            // Switching Rolls moves the folder being watched with it.
            unwatch();
            unwatch = watchRoll(tui.roll.root, () => {
              if (tui.externalChange()) draw();
            });
          }
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
    unwatch();
    out.off("resize", draw);
    process.off("exit", restore);
    restore();
    process.stdin.pause();
  }
}
