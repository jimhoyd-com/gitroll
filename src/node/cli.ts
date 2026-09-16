#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { planIngest, withDefaults } from "../core/adapter.ts";
import { ADAPTERS, getAdapter } from "../core/adapters/index.ts";
import type { Amount } from "../core/entry.ts";
import type { EntryChanges, LoadedEntry } from "../core/layout.ts";
import { findEntry } from "../core/layout.ts";
import { SearchIndex, facets } from "../core/search.ts";
import { codeRefs, refLabel, sourceRef } from "../core/code.ts";
import { related } from "../core/relations.ts";
import { TEMPLATES, findTemplate, renderTemplate, templateIds } from "../core/templates.ts";
import { UserError, basename, extname, isoDate, mimeFor, parseAmount } from "../core/util.ts";
import { AI_PRESETS, askRoll, isLocalEndpoint, privacyNote, testConnection } from "./ai.ts";
import { gh, ghSignedIn, githubVisibility, hasGh, parseGitHubRemote } from "./github.ts";
import { GitRoll, describeBlocker, displayRemote, findGitRoot, findRepoRoot, isLocalDestination, isRepo } from "./repo.ts";
import type { FileInput, SyncResult } from "./repo.ts";
import { serve } from "./server.ts";
import { commands, detectInstall, downloadVerified, latestVersion, newer, run } from "./install.ts";
import type { Install } from "./install.ts";
import { parsePaths, runTui, tuiSupported } from "./tui/app.ts";
import type { Draft } from "./tui/compose.ts";
import { addRoll, aiOn, configDir, findRoll, loadUserConfig, rollKey, rollsHome, saveUserConfig } from "./user-config.ts";
import type { AiSettings } from "./user-config.ts";

const HELP = `GitRoll: log what happened, find it later.

  gitroll                      Open GitRoll (the terminal workspace; /web opens the browser)
  gitroll menu  (or gitroll -i) The workspace: type to log, / for commands, ↑↓ to browse
  gitroll setup                Create your first Roll (a private logbook)
  gitroll log "what happened"  Log something. Add photos or receipts after the text:
                                 gitroll log "AC serviced, $325" invoice.pdf
  gitroll find "words"         Find events
  gitroll ask "question"       Ask your Roll, using an AI model you choose (gitroll ai)
  gitroll sync                 Back up and get changes from others
  gitroll rolls                List your Rolls (switch with: gitroll switch <name>)
  gitroll share <github-user>  Let someone else log in this Roll

  gitroll help more            Everything else
`;

const MORE = `More GitRoll commands

Rolls
  rolls add [folder]           Add a repository with a log that you cloned yourself
  new <name> [--github] [--template <folder|owner/repo>]
                               Create a Roll (with --github, also a private GitHub backup)
  init [--dir <folder>]        Add a log (.gitroll/) to the repository you are in
  join <owner/repo | url>      Download a Roll someone shared with you
  switch <name>                Make a Roll the one GitRoll uses by default
  rename <new name>            Rename the current Roll
  backup [git url]             Connect the current Roll to a private GitHub repository
  forget <name>                Remove a Roll from this list (files stay)
  remove <name> --delete-files Delete a Roll's folder from this computer (GitHub copy stays)
  status                       What's saved, what still needs syncing

Events
  log "text" [files] [--title <title>] [-p <project>] [-t <tag>] [--amount <amount>] [--at <date>]
      [--editor] [--template <name>] [--code]
                               --editor writes it in $VISUAL or $EDITOR; --template starts from
                               one of: debugging, incident, deployment, experiment, decision
                               --code records the repository, branch and commit you're on
  find "words"                 Also: project:house tag:payment after:2026-01-01 amount:>500 has:receipt
      [--save <name>] [--all]  Keep a search to reuse as @name, or search every Roll you have
  today | recent [-n 20]       Events from today, or the latest ones
  show <file> | history <file> One event, or every change made to it
  edit <file> [--text ..] [--title ..] [--amount ..|none] [--at ..] [-p ..] [-t ..] [files] [--editor]
  restore <file> [<commit>]    Put an earlier version back, as a new commit
  move <file> <new path>       Rename or reorganize an event, keeping its links and history
  delete <file>                Remove an event from the timeline (history keeps it)
  related <file>               What this event links to, and what links back to it

Events are Markdown files under .gitroll/events/. Refer to one by its file name
(2026-09-15-ac-serviced) or its path (events/2026-09-15-ac-serviced.md).

Organize
  projects                     Projects your events mention (they need no setup)
  templates                    Starting points for the kinds of event developers write often
  searches                     Searches you've saved (find --save <name> keeps one)
  template [--set <n>]         Show this Roll's template version, or record one

Ask your Roll
  ai                           Show how Ask is set up, and what leaves this computer
  ai <provider> [--model <m>]  ollama, lmstudio, llamacpp (on this computer), openai, openrouter
  ai custom --endpoint <url> --model <name> [--api-key-env VAR] [--allow-remote]
  ai test                      Check the connection and the model, with a real request
  ai on | ai off               Turn Ask on or off without forgetting the settings
  ask "question"               Answer from your events, with links to the ones it used
  summary [--since <date>]     Draft an update from what you logged. You review it before it's saved.

Sync problems
  conflicts                    Events changed in two places, shown side by side
  resolve <file> --mine | --theirs | --editor
                               Settle one, as a new commit. Both versions stay in history.

Sharing
  share                        Who can access this Roll
  share <github-user> [--read-only]
  unshare <github-user>
  trust [backup address]       Allow a non-GitHub backup that GitRoll can't check for privacy (untrust <address> to undo)

Maintenance
  check                        Check the Roll for problems
  doctor                       Check setup, privacy and security
  export [--format json|markdown] [-o file]
  import webhook <file.json>   Log events from JSON (each needs an "id"; duplicates are skipped)
  open [name] [--port 4321] [--no-browser]
  completion <bash|zsh|fish>   Print a completion script (see the line it prints to install it)
  version                      Show the installed version and how it was installed
  upgrade                      Install the latest version (your Rolls don't change)
  uninstall [--remove-settings] Remove the app. Your Rolls are never deleted.

Options for any command: --roll <name> or -C <folder> picks a Roll. --json prints machine-readable output.
--plain turns off prompts and colors (automatic outside a terminal, or when NO_COLOR is set).
Settings live in ${configDir()}; Rolls are created in ${rollsHome()} by default.
`;

let tty = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const eventName = (p: string) => p.replace(/^\.gitroll\/events\//, "").replace(/\.md$/, "");

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals: all } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string", short: "C" },
      roll: { type: "string", short: "r" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      title: { type: "string" },
      set: { type: "string" },
      editor: { type: "boolean" },
      code: { type: "boolean" },
      save: { type: "string" },
      all: { type: "boolean" },
      mine: { type: "boolean" },
      theirs: { type: "boolean" },
      since: { type: "string" },
      project: { type: "string", short: "p", multiple: true },
      tag: { type: "string", short: "t", multiple: true },
      file: { type: "string", short: "f", multiple: true },
      data: { type: "string", short: "d", multiple: true },
      at: { type: "string" },
      amount: { type: "string" },
      text: { type: "string" },
      limit: { type: "string", short: "n" },
      github: { type: "boolean" },
      owner: { type: "string" },
      template: { type: "string" },
      dir: { type: "string" },
      "delete-files": { type: "boolean" },
      "read-only": { type: "boolean" },
      field: { type: "string", multiple: true },
      model: { type: "string" },
      endpoint: { type: "string" },
      "api-key-env": { type: "string" },
      "allow-remote": { type: "boolean" },
      format: { type: "string" },
      output: { type: "string", short: "o" },
      port: { type: "string" },
      "no-browser": { type: "boolean" },
      event: { type: "string" },
      "dry-run": { type: "boolean" },
      interactive: { type: "boolean", short: "i" },
      plain: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      "remove-settings": { type: "boolean" },
    },
  });
  const [command = "", ...args] = all;
  if (v.plain) tty = false;

  if (v.version || command === "version") {
    const install = detectInstall();
    console.log(v.json ? JSON.stringify(install) : `GitRoll ${install.version} (${describeInstall(install)})`);
    return;
  }

  if (v.help || command === "help") {
    process.stdout.write(args[0] === "more" || args[0] === "all" ? MORE : HELP);
    return;
  }

  const openRoll = () => resolveRoll(v.repo, v.roll);
  const names = (_roll: GitRoll) => new Map<string, string>();

  switch (command) {
    case "menu":
      return menu(v.repo, v.roll, v.port, !!v.plain);
    case "":
      if (v.interactive) return menu(v.repo, v.roll, v.port, !!v.plain);
      return openHere(v.repo, v.roll, v.port, !v["no-browser"], v.yes ?? false, !!v.plain || v["no-browser"] !== undefined);
    case "open":
    case "serve":
      return openWebApp(args[0] ? new GitRoll(findRoll(args[0]).path) : openRoll(), v.port, !v["no-browser"]);

    case "setup":
      return setup(v.yes ?? false);

    // ── Rolls ───────────────────────────────────────────────────────────────
    case "new":
    case "init": {
      const name = args.join(" ") || (command === "init" ? path.basename(path.resolve(v.dir ?? ".")) : "");
      if (!name) throw new UserError('Give your Roll a name: gitroll new "Home"');
      const dir = command === "init" ? path.resolve(v.dir ?? ".") : path.resolve(v.dir ?? path.join(rollsHome(), rollKey(name)));
      const roll = createRoll(name, dir, v.template);
      if (v.github) connectGitHub(roll, v.owner);
      console.log(green(`Created the Roll "${name}"`) + dim(` in ${roll.root}`));
      if (!roll.status().remote) console.log(`Back it up to a private GitHub repository any time: ${bold("gitroll backup")}`);
      console.log(`Open it: ${bold("gitroll")}`);
      return;
    }
    case "join":
    case "clone":
      return join(args[0], args[1]);
    case "rolls":
    case "list": {
      if (args[0] === "add") {
        const dir = path.resolve(args[1] ?? ".");
        if (!fs.existsSync(dir)) throw new UserError(`Folder not found: ${dir}`);
        const root = findRepoRoot(dir);
        if (!root) {
          if (isBlankFolder(dir)) throw new UserError(`${dir} is empty. To make it a Roll, run: gitroll init --dir "${dir}"`);
          throw new UserError(`${dir} has no log in it (there's no .gitroll/config.yaml), so GitRoll won't change it.`);
        }
        const { roll, key, added } = registerRoll(root);
        return console.log(added ? green(`Added "${roll.config().name}" as ${key}.`) + ` Open it with: ${bold(`gitroll open ${key}`)}` : `"${roll.config().name}" is already in your Rolls (${key}).`);
      }
      const config = loadUserConfig();
      const rows = Object.entries(config.rolls).map(([key, r]) => {
        const exists = isRepo(r.path);
        const status = exists ? new GitRoll(r.path).status() : null;
        return { key, path: r.path, default: key === config.defaultRoll, missing: !exists, remote: status?.remoteUrl ?? null, unsynced: status?.ahead ?? 0 };
      });
      if (v.json) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log("You don't have any Rolls yet. Run: gitroll setup");
      for (const r of rows) {
        const state = r.missing ? red("folder missing") : !r.remote ? yellow("not backed up") : r.unsynced ? yellow(`${r.unsynced} to sync`) : green("synced");
        console.log(`${r.default ? "●" : " "} ${bold(r.key.padEnd(22))} ${state.padEnd(tty ? 25 : 16)} ${dim(r.path)}`);
      }
      console.log(dim("\n● is the Roll GitRoll opens by default. Change it with: gitroll switch <name>"));
      return;
    }
    case "switch":
    case "use": {
      const roll = findRoll(need(args[0], "gitroll switch <name>"));
      const config = loadUserConfig();
      config.defaultRoll = roll.key;
      saveUserConfig(config);
      return console.log(`GitRoll will now use ${bold(roll.key)}.`);
    }
    case "rename": {
      const roll = openRoll();
      roll.rename(need(args.join(" "), 'gitroll rename "New name"'));
      return console.log(`Renamed to ${bold(roll.config().name)}.`);
    }
    case "forget": {
      const { key } = findRoll(need(args[0], "gitroll forget <name>"));
      const config = loadUserConfig();
      delete config.rolls[key];
      if (config.defaultRoll === key) config.defaultRoll = Object.keys(config.rolls)[0];
      saveUserConfig(config);
      return console.log(`Removed ${key} from your list. Its files are still on this computer.`);
    }
    case "remove": {
      const { key, path: dir } = findRoll(need(args[0], "gitroll remove <name> --delete-files"));
      if (!v["delete-files"]) throw new UserError(`This deletes the folder ${dir}. To confirm, run: gitroll remove ${key} --delete-files`);
      if (isRepo(dir)) {
        const status = new GitRoll(dir).status();
        if (!status.remote || status.ahead > 0 || status.dirty) {
          const why = !status.remote ? "it has never been backed up" : "it has changes that haven't been synced";
          if (!(await confirm(`${key} can't be recovered because ${why}. Delete it anyway?`, v.yes))) return;
        } else if (!(await confirm(`Delete ${dir} from this computer? Your GitHub backup stays.`, v.yes))) return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      const config = loadUserConfig();
      delete config.rolls[key];
      if (config.defaultRoll === key) config.defaultRoll = Object.keys(config.rolls)[0];
      saveUserConfig(config);
      return console.log(`Deleted ${key} from this computer.`);
    }
    case "backup": {
      const roll = openRoll();
      if (args[0]) {
        if (roll.status().remote) throw new UserError("This Roll is already backed up. Run: gitroll sync");
        roll.git(["remote", "add", "origin", args[0]]);
      } else if (!roll.status().remote) {
        connectGitHub(roll, v.owner);
        return console.log(green("Backed up to a new private GitHub repository."));
      }
      return printSync(await roll.sync(), v.json);
    }
    case "status": {
      const roll = openRoll();
      const status = roll.status();
      const { entries, problems } = roll.load();
      if (v.json) {
        return console.log(
          JSON.stringify(
            {
              name: roll.config().name,
              path: roll.root,
              events: entries.length,
              problems: problems.length,
              template: roll.template(),
              ...status,
            },
            null,
            2,
          ),
        );
      }
      console.log(bold(roll.config().name) + dim(`  ${roll.root}`));
      console.log(`${entries.length} events${entries[0]?.date ? `, latest ${entries[0].date.slice(0, 10)}` : ""}${status.branch ? ` · branch ${status.branch}` : ""}`);
      if (status.blocker) console.log(yellow(describeBlocker(status.blocker)));
      if (!status.remote) console.log(yellow("Not backed up yet. Run: gitroll backup"));
      else if (status.ahead) console.log(yellow(`${status.ahead} ${status.ahead === 1 ? "change" : "changes"} to sync with ${status.remoteUrl}. Run: gitroll sync`));
      else console.log(green(`Synced with ${status.remoteUrl}`));
      if (status.uncommitted) console.log(dim(`${status.uncommitted} ${status.uncommitted === 1 ? "file was" : "files were"} edited outside GitRoll and aren't committed yet.`));
      if (problems.length) console.log(red(`${problems.length} ${problems.length === 1 ? "file has" : "files have"} problems. Run: gitroll check`));
      return;
    }

    // ── Events ─────────────────────────────────────────────────────────────
    case "log":
    case "add": {
      const roll = openRoll();
      const { text, files } = splitTextAndFiles(args, v.file);
      if (!text && !files.length && canPrompt(!!v.plain)) {
        const ui = createUi();
        try {
          return await promptLog(roll, ui);
        } finally {
          ui.close();
        }
      }
      let body = text;
      if (!body && !files.length && !process.stdin.isTTY) body = fs.readFileSync(0, "utf8");
      const template = v.template ? needTemplate(v.template) : null;
      if (template || v.editor) {
        // The editor is the source of truth for what gets logged: whatever comes
        // back is the event, and an empty file logs nothing.
        const start = template ? renderTemplate(template, v.title ?? body) : body ? `${body}\n` : "";
        body = openEditor(start, ".md");
        if (!body.trim()) return console.log("Nothing logged.");
      }
      // The repository you're standing in, or the log's own when you're elsewhere.
      const source = v.code ? (roll.sourceNow(process.cwd()) ?? roll.sourceNow()) : null;
      if (v.code && !source) throw new UserError("--code needs a Git repository with a commit in it; GitRoll couldn't find one to record.");
      const { entry, notices } = roll.save(
        {
          text: body,
          title: template ? undefined : v.title,
          date: v.at,
          projects: v.project,
          tags: [...(v.tag ?? []), ...(template?.tags ?? [])],
          amount: v.amount ? amountArg(v.amount) : undefined,
          ...(source ? { source } : {}),
        },
        files,
      );
      if (v.json) return console.log(JSON.stringify({ entry, notices }, null, 2));
      console.log(green("Logged."));
      printEntry(entry, names(roll));
      for (const n of notices) console.log(yellow(n));
      return;
    }
    case "find":
    case "search": {
      const roll = openRoll();
      const query = savedQuery(need(args.join(" "), 'gitroll find "words"'));
      if (v.save) {
        const config = loadUserConfig();
        config.searches = { ...config.searches, [rollKey(v.save)]: query };
        saveUserConfig(config);
        console.log(`${green("Saved")} that search as ${bold(`@${rollKey(v.save)}`)}. Use it with: gitroll find @${rollKey(v.save)}`);
      }
      if (v.all) return findEverywhere(query, v.json);
      return list(searchRoll(roll, query), names(roll), v.json, "Nothing found.");
    }
    case "today": {
      const roll = openRoll();
      const today = isoDate();
      return list(roll.entries().filter((e) => e.date?.slice(0, 10) === today), names(roll), v.json, "Nothing logged today.");
    }
    case "recent":
    case "timeline": {
      const roll = openRoll();
      return list(roll.entries().slice(0, Number(v.limit ?? 20)), names(roll), v.json, 'Nothing logged yet. Try: gitroll log "Started using GitRoll"');
    }
    case "show": {
      const roll = openRoll();
      const e = roll.entry(need(args[0], "gitroll show <file>"));
      if (v.json) return console.log(JSON.stringify(e, null, 2));
      printEntry(e, names(roll));
      for (const [key, value] of Object.entries(e.meta)) {
        if (["projects", "tags", "amount", "currency", "date", "title", "source"].includes(key)) continue;
        console.log(`  ${dim(key)}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
      }
      for (const a of e.attachments) {
        const file = roll.attachmentFile(a.path);
        console.log(`  ${a.name}  ${dim(file ? path.relative(process.cwd(), file) : `${a.path} (missing)`)}`);
      }
      const src = sourceRef(e);
      if (src) {
        // The source repository's branch, which is not the branch this Roll is on.
        const where = [src.repo, src.branch ? `branch ${src.branch}` : "", src.commit ? src.commit.slice(0, 12) : ""].filter(Boolean).join(" · ");
        console.log(`  ${dim("Code:")} ${where}`);
      }
      for (const ref of codeRefs(e)) {
        console.log(`  ${dim(`${refLabel(ref.kind)}:`)} ${ref.text}${ref.url ? dim(`  ${ref.url}`) : ""}`);
      }
      const rel = related(e, roll.entries());
      for (const x of rel.links) console.log(`  ${dim("links to:")} ${eventName(x.path)}  ${x.title}`);
      for (const x of rel.backlinks) console.log(`  ${dim("linked from:")} ${eventName(x.path)}  ${x.title}`);
      console.log(dim(`  ${e.path}${e.date ? ` · dated from the ${e.dateFrom === "metadata" ? "front matter" : "file name"}` : " · undated"}`));
      return;
    }
    case "edit": {
      const roll = openRoll();
      const [id, ...rest] = args;
      const { files } = splitTextAndFiles(["", ...rest], v.file);
      const changes: EntryChanges = { text: v.text, title: v.title, projects: v.project, tags: v.tag };
      if (v.editor) {
        // Edit the event as it is written, front matter and all — the same text
        // a text editor would show, because that is all an event is.
        const current = roll.entry(need(id, "gitroll edit <file> --editor"));
        const edited = openEditor(`${roll.entrySource(current.path)}`, ".md");
        if (!edited.trim()) throw new UserError("The file came back empty, so nothing was saved.");
        changes.text = edited.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "").replace(/^\s*\n/, "");
      }
      if (v.at !== undefined) changes.date = v.at;
      if (v.amount !== undefined) changes.amount = v.amount === "none" ? null : amountArg(v.amount);
      const { entry, notices } = roll.saveChanges(need(id, 'gitroll edit <file> --text "..."'), changes, files);
      if (v.json) return console.log(JSON.stringify({ entry, notices }, null, 2));
      console.log(green("Saved. The earlier version is kept in history."));
      printEntry(entry, names(roll));
      for (const n of notices) console.log(yellow(n));
      return;
    }
    case "delete":
    case "rm": {
      const roll = openRoll();
      const e = roll.entry(need(args[0], "gitroll delete <file>"));
      printEntry(e, names(roll));
      if (!(await confirm("Delete this event? Its history is kept.", v.yes))) return;
      roll.deleteEntry(e.path);
      return console.log("Deleted. It's still in the Roll's history.");
    }
    case "history": {
      const roll = openRoll();
      const items = roll.history(need(args[0], "gitroll history <file>"));
      if (v.json) return console.log(JSON.stringify(items, null, 2));
      items.forEach((h, i) => {
        console.log(`${bold(i === items.length - 1 ? "Logged" : "Edited")} ${h.date.slice(0, 16).replace("T", " ")} by ${h.author}`);
        const lines = h.patch.split("\n");
        const start = lines.findIndex((l) => l.startsWith("@@"));
        if (i === items.length - 1) return;
        for (const l of lines.slice(Math.max(start, 0))) {
          if (/^\+[^+]/.test(l)) console.log(green(`  ${l}`));
          else if (/^-[^-]/.test(l)) console.log(red(`  ${l}`));
        }
      });
      return;
    }

    // ── Organize ─────────────────────────────────────────────────────────────
    case "projects":
    case "project": {
      const roll = openRoll();
      const entries = roll.entries();
      const projects = roll.projects();
      if (v.json) return console.log(JSON.stringify(projects, null, 2));
      if (!projects.length) return console.log('No projects yet. Add one to an event: gitroll log "Fixed the gate" -p house');
      for (const p of projects) console.log(`${bold(p.padEnd(28))} ${dim(`${entries.filter((e) => e.projects.includes(p)).length} events`)}`);
      return;
    }
    case "restore": {
      const roll = openRoll();
      const file = need(args[0], "gitroll restore <file> [<commit>]");
      const commit = args[1] ?? roll.previousVersion(file);
      if (!commit) throw new UserError("This event has only ever said one thing, so there's nothing earlier to put back.");
      const { entry, from, unchanged } = roll.restoreVersion(file, commit);
      if (v.json) return console.log(JSON.stringify({ entry, from, unchanged }, null, 2));
      if (unchanged) return console.log(`That version of ${eventName(entry.path)} is already what's here. Nothing changed.`);
      console.log(green(`Put back the version from ${from}, as a new commit.`) + dim(" Every version in between is still in history."));
      return printEntry(entry, names(roll));
    }
    case "related": {
      const roll = openRoll();
      const entries = roll.entries();
      const e = findEntry(entries, need(args[0], "gitroll related <file>"));
      const { links, backlinks, missing } = related(e, entries);
      if (v.json) {
        return console.log(JSON.stringify({ links: links.map((x) => x.path), backlinks: backlinks.map((x) => x.path), missing }, null, 2));
      }
      printEntry(e, names(roll));
      if (links.length) {
        console.log(bold("Links to"));
        for (const x of links) console.log(`  ${dim(eventName(x.path).padEnd(40))} ${x.title}`);
      }
      if (backlinks.length) {
        console.log(bold("Linked from"));
        for (const x of backlinks) console.log(`  ${dim(eventName(x.path).padEnd(40))} ${x.title}`);
      }
      for (const m of missing) console.log(yellow(`  Links to ${m}, which isn't in this Roll.`));
      if (!links.length && !backlinks.length && !missing.length) {
        console.log(dim("Nothing links either way yet. Link one event from another with an ordinary Markdown link:"));
        console.log(dim("  Follows [the incident](2026-09-14-checkout-timeouts.md)."));
      }
      return;
    }
    case "conflicts": {
      const roll = openRoll();
      const conflicts = roll.conflicts();
      if (v.json) return console.log(JSON.stringify(conflicts, null, 2));
      if (!conflicts.length) return console.log("Nothing to settle: no event was changed in two places.");
      for (const c of conflicts) {
        console.log(`${bold(eventName(c.entry.path))}${dim(`  changed in two places on ${c.noted}`)}`);
        printSideBySide(c.mine, c.theirs);
        console.log(dim(`  Settle it: gitroll resolve ${eventName(c.entry.path)} --mine | --theirs | --editor\n`));
      }
      return;
    }
    case "resolve": {
      const roll = openRoll();
      const file = need(args[0], "gitroll resolve <file> --mine | --theirs | --editor");
      const conflict = roll.conflicts().find((c) => c.entry.path === roll.entry(file).path);
      if (!conflict) throw new UserError(`${file} isn't waiting on a conflict. See: gitroll conflicts`);
      let choice: "mine" | "theirs" | { text: string };
      if (v.mine) choice = "mine";
      else if (v.theirs) choice = "theirs";
      else if (v.editor) {
        const start =
          `${conflict.mine}\n\n<!-- ─── The version from the other device is below. Edit this file into the one you want to keep, ` +
          `delete the rest, and save. Both versions stay in Git history either way. ─── -->\n\n${conflict.theirs}\n`;
        const text = openEditor(start, ".md").replace(/<!--[\s\S]*?-->/g, "").trim();
        if (!text) return console.log("Nothing changed: the file came back empty.");
        choice = { text };
      } else {
        printSideBySide(conflict.mine, conflict.theirs);
        throw new UserError("Say which one to keep: --mine, --theirs, or --editor to write the version you want.");
      }
      const entry = roll.resolveConflict(file, choice);
      console.log(green("Settled, as a new commit.") + dim(" The other version is still in this event's history."));
      return printEntry(entry, names(roll));
    }
    case "templates": {
      if (v.json) return console.log(JSON.stringify(TEMPLATES, null, 2));
      console.log("Starting points for an event. Each one is ordinary Markdown you can change or ignore.\n");
      for (const t of TEMPLATES) console.log(`  ${bold(t.id.padEnd(12))} ${t.label.padEnd(24)} ${dim(t.description)}`);
      return console.log(`\nUse one: ${bold('gitroll log --template incident "Checkout timeouts"')}`);
    }
    case "searches": {
      const config = loadUserConfig();
      const saved = Object.entries(config.searches ?? {});
      if (args[0] === "remove") {
        const key = rollKey(need(args[1], "gitroll searches remove <name>"));
        if (!config.searches?.[key]) throw new UserError(`There's no saved search called "${args[1]}".`);
        delete config.searches[key];
        saveUserConfig(config);
        return console.log(`Removed @${key}.`);
      }
      if (v.json) return console.log(JSON.stringify(Object.fromEntries(saved), null, 2));
      if (!saved.length) return console.log('No saved searches yet. Keep one: gitroll find "tag:incident has:date" --save open-incidents');
      for (const [key, query] of saved) console.log(`  ${bold(`@${key}`.padEnd(24))} ${dim(query)}`);
      return;
    }
    case "completion":
      return console.log(completionScript(need(args[0], "gitroll completion <bash|zsh|fish>")));
    // Called by the completion scripts. Prints one name per line, and never fails.
    case "__complete":
      return completeList(args[0], v.repo, v.roll);
    case "move":
    case "mv": {
      const roll = openRoll();
      const e = roll.moveEntry(need(args[0], "gitroll move <file> <new path>"), need(args[1], "gitroll move <file> <new path>"));
      return console.log(`${green("Moved")} to ${e.path}. Links to files were updated; history follows the rename.`);
    }
    case "template": {
      const roll = openRoll();
      const status = roll.template();
      const set = v.set ?? (args[0] === "set" ? args[1] : undefined);
      if (set !== undefined) {
        const version = Number(set);
        roll.setTemplateVersion(version);
        return console.log(green(`Recorded template_version: ${version} in gitroll.yaml.`));
      }
      if (v.json) return console.log(JSON.stringify(status, null, 2));
      console.log(status.code === "ok" ? green(status.message) : yellow(status.message));
      return;
    }

    // ── Sync and sharing ────────────────────────────────────────────────────
    case "sync": {
      const roll = openRoll();
      return printSync(await roll.sync(), v.json);
    }
    case "share": {
      const roll = openRoll();
      const repo = githubRepoOf(roll);
      if (!args[0]) {
        const people = JSON.parse(gh(["api", `repos/${repo.owner}/${repo.repo}/collaborators`, "--paginate"])) as { login: string; permissions?: { push?: boolean } }[];
        if (v.json) return console.log(JSON.stringify(people, null, 2));
        for (const p of people) console.log(`${bold(p.login.padEnd(24))} ${dim(p.permissions?.push ? "can log" : "can read")}`);
        return console.log(dim(`\nInvitations waiting to be accepted: https://github.com/${repo.owner}/${repo.repo}/settings/access`));
      }
      const user = args[0].replace(/^@/, "");
      gh(["api", "-X", "PUT", `repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(user)}`, "-f", `permission=${v["read-only"] ? "pull" : "push"}`]);
      console.log(green(`Invited ${user}.`) + ` Once they accept on GitHub, they run:`);
      return console.log(bold(`  gitroll join ${repo.owner}/${repo.repo}`));
    }
    case "trust": {
      const config = loadUserConfig();
      if (!args[0]) {
        const list = config.trustedRemotes ?? [];
        return console.log(list.length ? list.join("\n") : "No trusted backup addresses. GitHub repositories are always checked automatically.");
      }
      const shown = displayRemote(args[0]);
      if (parseGitHubRemote(args[0]) || parseGitHubRemote(`https://${shown}`)) {
        throw new UserError("GitHub repositories are checked automatically on every sync and can't be trusted manually.");
      }
      if (!(await confirm(`Upload to ${shown} without checking whether it's private?`, v.yes))) return;
      config.trustedRemotes = [...new Set([...(config.trustedRemotes ?? []), shown])];
      saveUserConfig(config);
      return console.log(`GitRoll will sync with ${shown}. Make sure only you and people you trust can read it.`);
    }
    case "untrust": {
      const config = loadUserConfig();
      const shown = displayRemote(need(args[0], "gitroll untrust <backup address>"));
      config.trustedRemotes = (config.trustedRemotes ?? []).filter((t) => t.toLowerCase() !== shown.toLowerCase());
      saveUserConfig(config);
      return console.log(`GitRoll will no longer sync with ${shown} until you trust it again.`);
    }
    case "unshare": {
      const roll = openRoll();
      const repo = githubRepoOf(roll);
      const user = need(args[0], "gitroll unshare <github-user>").replace(/^@/, "");
      gh(["api", "-X", "DELETE", `repos/${repo.owner}/${repo.repo}/collaborators/${encodeURIComponent(user)}`]);
      console.log(`${user} can no longer sync this Roll.`);
      return console.log(dim("Anything they already downloaded stays on their computer."));
    }

    // ── Ask your Roll ───────────────────────────────────────────────────────
    case "ai":
      return aiCommand(args, v);
    case "ask": {
      const roll = openRoll();
      const question = need(args.join(" "), 'gitroll ask "When was the AC last serviced?"');
      const ai = askableAi(roll);
      const { answer, sources } = await askRoll(ai, roll.entries(), question, names(roll));
      if (v.json) return console.log(JSON.stringify({ answer, sources: sources.map((e) => e.path) }, null, 2));
      console.log(answer);
      if (sources.length) {
        console.log(dim("\nFrom these events:"));
        for (const e of sources) printEntry(e, names(roll));
      } else {
        console.log(dim("\nNo event was cited, so treat this as a guess rather than a record."));
      }
      return;
    }
    case "summary": {
      // A draft, never a saved event: what comes back is text on screen until
      // the person decides to keep it.
      const roll = openRoll();
      const since = v.since ?? isoDate(new Date(Date.now() - 7 * 86_400_000));
      const ai = askableAi(roll);
      const entries = searchRoll(roll, `after:${since}`);
      if (!entries.length) return console.log(`Nothing logged since ${since}, so there's nothing to summarize.`);
      const ask = args.join(" ") || "Write a short update on what happened, grouped by topic, for someone who wasn't here.";
      const { answer, sources } = await askRoll(ai, entries, `${ask} Only use the events given.`, names(roll));
      if (v.json) return console.log(JSON.stringify({ since, draft: answer, sources: sources.map((e) => e.path) }, null, 2));
      console.log(bold(`Draft update since ${since}`) + dim(`  from ${entries.length} ${entries.length === 1 ? "event" : "events"}`));
      console.log(`\n${answer}\n`);
      if (sources.length) console.log(dim(`From: ${sources.map((e) => eventName(e.path)).join(", ")}`));
      console.log(
        dim("\nNothing was saved. Read it, fix what's wrong, then keep it with:\n") +
          bold(`  gitroll log --editor --template deployment "Update since ${since}"`),
      );
      return;
    }

    // ── Maintenance ─────────────────────────────────────────────────────────
    case "check": {
      const roll = openRoll();
      const problems = roll.check();
      const sensitive = roll.sensitive();
      if (v.json) return console.log(JSON.stringify({ problems, sensitive }, null, 2));
      for (const p of problems) console.log(`${red("✗")} ${p.path || "Roll"}: ${p.error}`);
      for (const p of sensitive) console.log(`${yellow("!")} ${p.path}: ${p.error}`);
      console.log(problems.length ? `${problems.length} ${problems.length === 1 ? "problem" : "problems"} found.` : green("The Roll looks good."));
      if (problems.length) process.exitCode = 1;
      return;
    }
    case "upgrade":
    case "update":
      return upgrade(v.yes ?? false, v["dry-run"] ?? false);
    case "uninstall":
      return uninstall(v.yes ?? false, v["dry-run"] ?? false, v["remove-settings"] ?? false);
    case "doctor":
      return doctor(v.repo, v.roll);
    case "export": {
      const roll = openRoll();
      const format = (v.format ?? "json") as "json" | "markdown";
      if (format !== "json" && format !== "markdown") throw new UserError("Choose --format json or --format markdown");
      const out = roll.export(format);
      if (v.output) {
        fs.writeFileSync(v.output, out, { mode: 0o600 });
        return console.log(`Exported to ${v.output}. It contains your private events; store it carefully.`);
      }
      process.stdout.write(`${out}\n`);
      return;
    }
    case "import":
    case "ingest": {
      const roll = openRoll();
      const adapter = getAdapter(args[0] ?? "");
      if (!adapter) throw new UserError(`Usage: gitroll import <${ADAPTERS.map((a) => a.id).join("|")}> <file.json>`);
      const raw = !args[1] || args[1] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args[1], "utf8");
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new UserError("That file isn't valid JSON.");
      }
      const ctx = { options: { event: v.event, project: v.project?.join(","), tag: v.tag?.join(",") } };
      const drafts = withDefaults(adapter.toEvents(payload, ctx), ctx);
      if (v["dry-run"]) {
        const plan = planIngest(roll.entries(), drafts);
        return console.log(JSON.stringify({ create: plan.create, skip: plan.skip.map((d) => d.source) }, null, 2));
      }
      const { created, skipped } = roll.ingest(drafts);
      if (v.json) return console.log(JSON.stringify({ created, skipped: skipped.map((d) => d.source) }, null, 2));
      return console.log(`${created.length} logged, ${skipped.length} already in the Roll.`);
    }
    default:
      throw new UserError(`"${command}" isn't a GitRoll command. See: gitroll help`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// ── Interactive mode ────────────────────────────────────────────────────────

const QUIT = "\u0004";

interface Ui {
  /** Asks a question and returns the trimmed answer, or QUIT when input ends. */
  ask(question: string): Promise<string>;
  close(): void;
}

/** Prompts are only used in a real terminal (or when a test forces them), never in scripts. */
function canPrompt(plain: boolean): boolean {
  return !plain && (!!process.stdin.isTTY || process.env.GITROLL_FORCE_INTERACTIVE === "1");
}

/** One reader for a whole interactive session, so no typed or piped input is lost between prompts. */
function createUi(): Ui {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const queued: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    waiting?.(null);
    waiting = null;
  });
  return {
    async ask(question) {
      process.stdout.write(`${bold(question)} `);
      if (queued.length) return queued.shift()!.trim();
      if (ended) return QUIT;
      const line = await new Promise<string | null>((resolve) => (waiting = resolve));
      if (!process.stdin.isTTY) process.stdout.write("\n");
      return line === null ? QUIT : line.trim();
    },
    close: () => rl.close(),
  };
}

async function promptLog(roll: GitRoll, ui: Ui): Promise<void> {
  const text = await ui.ask("What happened?");
  if (!text || text === QUIT) return console.log("Nothing logged.");
  const attach = await ui.ask("Attach photos or files? Drag them here, or press Enter to skip:");
  const files = attach && attach !== QUIT ? parsePaths(attach).map(readFile) : [];
  const known = roll.projects();
  known.forEach((p, i) => console.log(`  ${i + 1}  ${p}`));
  const pick = await ui.ask(known.length ? "Project? Type a number or a new name, or press Enter to skip:" : "Project? Type a name, or press Enter to skip:");
  let projects: string[] = [];
  if (pick && pick !== QUIT) {
    if (/^\d+$/.test(pick)) {
      const chosen = known[Number(pick) - 1];
      if (chosen) projects = [chosen];
      else console.log(dim(`There's no project ${pick}; logging without one.`));
    } else projects = [pick];
  }
  const { entry, notices } = roll.save({ text, projects }, files);
  console.log(green("Logged."));
  printEntry(entry, projectNamesOf(roll));
  for (const n of notices) console.log(yellow(n));
}

function projectNamesOf(_roll: GitRoll): Map<string, string> {
  return new Map<string, string>();
}

function searchRoll(roll: GitRoll, query: string): LoadedEntry[] {
  return new SearchIndex(roll.entries()).search(query);
}

async function menu(dir: string | undefined, name: string | undefined, port: string | undefined, plain: boolean): Promise<void> {
  if (!canPrompt(plain)) throw new UserError('The menu needs an interactive terminal. In scripts, use commands such as: gitroll log "what happened"');
  return runMenu(resolveRoll(dir, name), port);
}

async function runMenu(start: GitRoll, port: string | undefined): Promise<void> {
  let roll = start;
  if (tuiSupported()) {
    const running: { close(): void }[] = [];
    try {
      return await runTui({
        roll,
        rolls: () => {
          const config = loadUserConfig();
          return Object.entries(config.rolls)
            .filter(([, r]) => isRepo(r.path))
            .map(([key, r]) => ({ key, name: new GitRoll(r.path).config().name, path: r.path }));
        },
        openRoll: (p) => new GitRoll(p),
        readFile,
        editFile,
        rememberRoll,
        drafts,
        editExternally,
        openInBrowser: async (r) => {
          const { server, url } = await serve(r, { port: port ? Number(port) : 0, ai: aiSettingsForServer() });
          running.push(server);
          openBrowser(url);
          return url;
        },
      });
    } finally {
      for (const server of running) server.close();
    }
  }
  const ui = createUi();
  try {
    for (;;) {
      const status = roll.status();
      const note = !status.remote ? dim(" · not backed up") : status.ahead ? yellow(` · ${status.ahead} to sync`) : green(" · synced");
      console.log(`\n${bold(roll.config().name)}${note}`);
      console.log("  1  Log something\n  2  Find\n  3  Recent\n  4  Sync\n  5  Switch Roll\n  6  Open in browser\n  q  Quit");
      const choice = (await ui.ask("Choose:")).toLowerCase();
      if (choice === QUIT || choice === "q" || choice === "quit") return;
      try {
        switch (choice) {
          case "1":
            await promptLog(roll, ui);
            break;
          case "2": {
            const query = await ui.ask("Search for:");
            if (query === QUIT) return;
            if (query) list(searchRoll(roll, query).slice(0, 20), projectNamesOf(roll), false, "Nothing found.");
            break;
          }
          case "3":
            list(roll.entries().slice(0, 10), projectNamesOf(roll), false, "Nothing logged yet.");
            break;
          case "4": {
            console.log(dim("Syncing…"));
            const result = await roll.sync();
            console.log(result.ok ? green(result.message) : red(result.message));
            break;
          }
          case "5": {
            const config = loadUserConfig();
            const keys = Object.keys(config.rolls).filter((k) => isRepo(config.rolls[k].path));
            if (keys.length < 2) {
              console.log('You have one Roll. Create another with: gitroll new "Name"');
              break;
            }
            keys.forEach((k, i) => console.log(`  ${i + 1}  ${k}`));
            const key = keys[Number(await ui.ask("Which Roll?")) - 1];
            if (key) roll = new GitRoll(config.rolls[key].path);
            else console.log(dim("Staying on this Roll."));
            break;
          }
          case "6":
            ui.close();
            return openWebApp(roll, port, true);
          default:
            console.log("Type a number from the list, or q to quit.");
        }
      } catch (e) {
        console.log(red(e instanceof UserError ? e.message : String(e)));
      }
    }
  } finally {
    ui.close();
  }
}

function need(value: string | undefined, usage: string): string {
  if (!value?.trim()) throw new UserError(`Usage: ${usage}`);
  return value.trim();
}

// ── Upgrade and uninstall ───────────────────────────────────────────────────

function describeInstall(install: Install): string {
  switch (install.method) {
    case "homebrew":
      return "installed with Homebrew";
    case "scoop":
      return "installed with Scoop";
    case "npm":
      return "installed with the installer or npm";
    default:
      return `running from source in ${install.root}`;
  }
}

async function upgrade(yes: boolean, dryRun: boolean): Promise<void> {
  const install = detectInstall();
  console.log(`GitRoll ${install.version}, ${describeInstall(install)}.`);
  if (install.method === "source") return console.log(`To update a source checkout, run: ${bold(commands.upgrade.source)}`);
  if (install.method === "homebrew") {
    if (dryRun) return console.log(`Would run: ${commands.upgrade.homebrew}`);
    if (!(await confirm("Upgrade with Homebrew now?", yes))) return;
    run("brew", ["upgrade", "gitroll"]);
    return console.log(green("Done. Your Rolls didn't need any changes."));
  }
  if (install.method === "scoop") {
    if (dryRun) return console.log(`Would run: ${commands.upgrade.scoop}`);
    if (!(await confirm("Upgrade with Scoop now?", yes))) return;
    run("scoop", ["update", "gitroll"]);
    return console.log(green("Done. Your Rolls didn't need any changes."));
  }
  const latest = await latestVersion();
  if (!newer(latest, install.version)) return console.log(green(`You have the latest version (${install.version}).`));
  console.log(`GitRoll ${latest} is available. See what's new: https://github.com/jimhoyd-com/gitroll/releases/tag/v${latest}`);
  if (dryRun) return console.log(`Would download gitroll-${latest}.tgz, check it against SHA256SUMS, and run: npm install --global <file>`);
  if (!(await confirm(`Upgrade to ${latest} now?`, yes))) return;
  const file = await downloadVerified(latest);
  console.log(dim("Checksum verified."));
  try {
    run("npm", ["install", "--global", "--no-audit", "--no-fund", file]);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  console.log(green(`Upgraded to GitRoll ${latest}. Your Rolls didn't need any changes.`));
}

async function uninstall(yes: boolean, dryRun: boolean, removeSettings: boolean): Promise<void> {
  const install = detectInstall();
  const settings = configDir();
  const rolls = Object.values(loadUserConfig().rolls).map((r) => r.path);
  console.log(`GitRoll ${install.version}, ${describeInstall(install)}.\n`);
  console.log(bold("This removes:"));
  console.log(`  • the GitRoll app${install.method === "source" ? " (nothing: delete the source folder yourself)" : ` (${commands.uninstall[install.method]})`}`);
  if (removeSettings) console.log(`  • GitRoll's settings: ${settings}`);
  console.log(bold("\nThis keeps:"));
  if (!removeSettings) console.log(`  • GitRoll's settings: ${settings} (add --remove-settings to remove them)`);
  console.log(`  • all of your Rolls${rolls.length ? ":" : ` (in ${rollsHome()} by default) and their GitHub repositories`}`);
  for (const r of rolls) console.log(`      ${r}`);
  if (dryRun) return console.log(dim("\nNothing was changed (--dry-run)."));
  if (install.method === "source" && !removeSettings) return console.log("\nGitRoll is running from source, so there's no installed app to remove.");
  if (!(await confirm("\nContinue?", yes))) return console.log("Nothing was changed.");
  if (removeSettings && fs.existsSync(settings)) {
    const files = fs.readdirSync(settings);
    if (files.length && !files.includes("config.json")) throw new UserError(`${settings} doesn't look like GitRoll's settings, so it was left alone.`);
    fs.rmSync(settings, { recursive: true, force: true });
    console.log(green("Removed GitRoll's settings."));
  }
  if (install.method === "homebrew") run("brew", ["uninstall", "gitroll"]);
  else if (install.method === "scoop") run("scoop", ["uninstall", "gitroll"]);
  else if (install.method === "npm") run("npm", ["uninstall", "--global", "gitroll"]);
  console.log(green(install.method === "source" ? "Done." : "GitRoll was uninstalled."));
  console.log("Your Rolls are untouched. To use them again, reinstall GitRoll and run gitroll inside a Roll folder.");
}

async function confirm(question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new UserError(`${question} Add --yes to confirm.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} (y/N) `)).trim());
  } finally {
    rl.close();
  }
}

async function prompt(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} ${dim(`(${fallback})`)} `)).trim() || fallback;
  } finally {
    rl.close();
  }
}

/** Files a new GitHub repository may already have that don't stop a folder counting as empty. */
const BLANK_FOLDER_FILES = new Set([".git", ".DS_Store", "README.md", "LICENSE", "LICENSE.md", "LICENSE.txt", ".gitignore", ".gitattributes"]);

function isBlankFolder(dir: string): boolean {
  return fs.readdirSync(dir).every((f) => BLANK_FOLDER_FILES.has(f));
}

/** Checks a Roll's shape, reports problems, and adds it to the user's list if it isn't there yet. */
function registerRoll(root: string): { roll: GitRoll; key: string; added: boolean } {
  const roll = new GitRoll(root);
  const problems = roll.check();
  if (problems.length) {
    console.log(yellow(`This Roll has ${problems.length} ${problems.length === 1 ? "problem" : "problems"}:`));
    for (const p of problems.slice(0, 5)) console.log(`  ${p.path || "Roll"}: ${p.error}`);
    if (problems.length > 5) console.log(dim(`  …and ${problems.length - 5} more.`));
    console.log(dim("  Run gitroll check for details. GitRoll will skip files it can't read."));
  }
  const config = loadUserConfig();
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const existing = Object.entries(config.rolls).find(([, r]) => real(r.path) === roll.root);
  if (existing) return { roll, key: existing[0], added: false };
  const base = rollKey(roll.config().name);
  let key = base;
  for (let n = 2; config.rolls[key]; n++) key = `${base}-${n}`;
  addRoll(key, roll.root);
  return { roll, key, added: true };
}

/**
 * Plain `gitroll`: open the log for the repository you're in, wherever in it you
 * are. When that repository has no log yet, ask — a repository someone is
 * working in is never changed without being asked, and GitRoll never quietly
 * opens a different Roll instead.
 */
async function openHere(dir: string | undefined, name: string | undefined, port: string | undefined, browser: boolean, yes: boolean, noTerminalApp: boolean): Promise<void> {
  // In a terminal, plain gitroll opens the terminal app (o opens the browser from there); otherwise the browser app.
  const openApp = (roll: GitRoll, p: string | undefined, b: boolean) => (!noTerminalApp && tuiSupported() ? runMenu(roll, p) : openWebApp(roll, p, b));
  if (dir || name || process.env.GITROLL_REPO) return openApp(resolveRoll(dir, name), port, browser);
  const cwd = process.cwd();

  const root = findRepoRoot(cwd);
  if (root) {
    const { roll, added } = registerRoll(root);
    if (added) console.log(dim(`Added "${roll.config().name}" to your Rolls.`));
    return openApp(roll, port, browser);
  }

  // Inside a Git repository with no log: offer to add one, right here.
  const git = findGitRoot(cwd);
  if (git) {
    const where = path.relative(cwd, git) || ".";
    console.log(`${bold(path.basename(git))} ${dim(git)} has no log yet.`);
    if (!canPrompt(noTerminalApp) && !yes) {
      throw new UserError(`To add one: gitroll init --dir "${where}". To open a Roll you already have: gitroll open <name>`);
    }
    console.log(`  1  Add a log to this repository ${dim("(creates .gitroll/, nothing else)")}`);
    console.log(`  2  Open another Roll`);
    console.log(`  3  Cancel`);
    const pick = yes ? "1" : await prompt("What would you like to do?", "3");
    if (pick === "2") {
      const config = loadUserConfig();
      const keys = Object.keys(config.rolls);
      if (!keys.length) throw new UserError('You don\'t have another Roll yet. Create one with: gitroll new "Name"');
      for (const key of keys) console.log(`  ${key}${dim(`  ${config.rolls[key].path}`)}`);
      const which = await prompt("Which one?", config.defaultRoll ?? keys[0]);
      return openApp(new GitRoll(findRoll(which).path), port, browser);
    }
    if (pick !== "1") return console.log("Nothing was changed.");
    const roll = GitRoll.init(git, { name: path.basename(git) });
    const { key } = registerRoll(roll.root);
    console.log(green(`Added a log to this repository (${key}).`) + dim(" Only .gitroll/ was created and committed."));
    console.log(dim("This log is as visible as the repository: .gitroll is a namespace, not a privacy boundary."));
    return openApp(roll, port, browser);
  }

  if (isBlankFolder(cwd)) {
    const rollName = path.basename(cwd);
    if (!yes && !process.stdin.isTTY) return console.log("This folder is empty. To make it a Roll, run: gitroll init");
    if (!(await confirm(`This folder is empty. Make it a Roll called "${rollName}"?`, yes))) return;
    const roll = GitRoll.init(cwd, { name: rollName });
    const { key } = registerRoll(roll.root);
    console.log(green(`Created the Roll "${rollName}" (${key}).`) + (roll.status().remote ? ` Back it up with: ${bold("gitroll sync")}` : ""));
    return openApp(roll, port, browser);
  }

  const config = loadUserConfig();
  if (!(config.defaultRoll && config.rolls[config.defaultRoll])) {
    process.stdout.write(HELP);
    console.log(bold("\nNew here? Run: gitroll setup"));
    return;
  }
  return openApp(resolveRoll(), port, browser);
}

function resolveRoll(dir?: string, name?: string): GitRoll {
  if (dir) return new GitRoll(dir);
  if (process.env.GITROLL_REPO) return new GitRoll(process.env.GITROLL_REPO);
  if (name) return new GitRoll(findRoll(name).path);
  const here = findRepoRoot();
  if (here) return new GitRoll(here);
  // Inside another repository, the default Roll is the wrong answer: say so.
  const git = findGitRoot();
  if (git) {
    throw new UserError(
      `${git} is a Git repository with no log in it. Add one with: gitroll init --dir "${git}". ` +
        "To use a Roll you already have, name it: gitroll --roll <name>",
    );
  }
  const config = loadUserConfig();
  const fallback = config.defaultRoll ? config.rolls[config.defaultRoll] : undefined;
  if (fallback) {
    if (!isRepo(fallback.path)) throw new UserError(`Your Roll "${config.defaultRoll}" isn't at ${fallback.path} anymore. See: gitroll rolls`);
    return new GitRoll(fallback.path);
  }
  throw new UserError("You don't have a Roll yet. Create one with: gitroll setup");
}

function createRoll(name: string, dir: string, template?: string): GitRoll {
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f !== ".git") && !fs.existsSync(path.join(dir, ".git"))) {
    throw new UserError(`${dir} already has files in it. Pick another folder with --dir.`);
  }
  const roll = GitRoll.init(dir, { name, template });
  addRoll(name, roll.root);
  return roll;
}

/** Creates a private GitHub repository for the Roll and uploads it, using the GitHub CLI. */
function connectGitHub(roll: GitRoll, owner?: string): void {
  if (!hasGh()) throw new UserError("To back up to GitHub automatically, install the GitHub CLI (https://cli.github.com), run `gh auth login`, then `gitroll backup`.\nOr create a private repository yourself and run: gitroll backup <its git url>");
  if (!ghSignedIn()) throw new UserError("Sign in to GitHub first: gh auth login");
  const repoName = rollKey(roll.config().name);
  gh(["repo", "create", owner ? `${owner}/${repoName}` : repoName, "--private", "--source", roll.root, "--remote", "origin", "--push", "--description", "GitRoll logbook (private)"]);
}

async function join(source: string | undefined, name?: string): Promise<void> {
  const from = need(source, "gitroll join <owner/repo>");
  const shorthand = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(from);
  const key = rollKey(name ?? from.replace(/\.git$/, "").split(/[/:]/).pop() ?? "roll");
  const dir = path.join(rollsHome(), key);
  if (fs.existsSync(dir)) throw new UserError(`${dir} already exists. Pick a different name: gitroll join ${from} <name>`);
  fs.mkdirSync(rollsHome(), { recursive: true });
  if (shorthand && hasGh()) gh(["repo", "clone", from, dir, "--", "-q"]);
  else {
    const url = shorthand ? `https://github.com/${from}.git` : from;
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("git", ["clone", "-q", url, dir], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (e) {
      throw new UserError(`Couldn't download ${from}. Check the name and that you've accepted the invitation.\n${String((e as { stderr?: Buffer }).stderr ?? "").trim()}`);
    }
  }
  if (!isRepo(dir)) {
    const empty = !fs.readdirSync(dir).some((f) => f !== ".git");
    if (!empty) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new UserError(`${from} isn't a GitRoll Roll.`);
    }
    GitRoll.init(dir, { name: key });
  }
  const roll = new GitRoll(dir);
  addRoll(key, roll.root);
  console.log(green(`Joined "${roll.config().name}".`) + dim(` It's in ${roll.root}`));
  console.log(`Open it: ${bold(`gitroll open ${key}`)}`);
}

async function setup(yes: boolean): Promise<void> {
  console.log(bold("Welcome to GitRoll."));
  console.log("A Roll is a private logbook. It lives in a folder on this computer and can be backed up to your own private GitHub repository.\n");
  const name = await prompt("What should your Roll be called?", "My Roll");
  const roll = createRoll(name, path.join(rollsHome(), rollKey(name)));
  console.log(green(`Created "${name}".`) + dim(` ${roll.root}`));
  if (hasGh() && ghSignedIn()) {
    if (yes || (await confirm("Back it up to a new private GitHub repository now?", false).catch(() => false))) {
      connectGitHub(roll);
      console.log(green("Backed up to GitHub (private)."));
    }
  } else {
    console.log(dim("To back up to GitHub later, install the GitHub CLI (https://cli.github.com), run `gh auth login`, then `gitroll backup`."));
  }
  if (process.stdin.isTTY && !yes && (await confirm("Open GitRoll now?", false).catch(() => false))) await openWebApp(roll, undefined, true);
  else console.log(`\nOpen GitRoll any time with: ${bold("gitroll")}`);
}

/** The app in the browser gets Ask only when it is set up and switched on. */
function aiSettingsForServer(): AiSettings | null {
  const ai = loadUserConfig().ai;
  return ai && aiOn(ai) ? ai : null;
}

async function openWebApp(roll: GitRoll, port: string | undefined, browser: boolean): Promise<void> {
  const ai = aiSettingsForServer();
  const tryPorts = port ? [Number(port)] : [4321, 4322, 4323, 4324, 0];
  let lastError: unknown;
  for (const p of tryPorts) {
    try {
      const { url } = await serve(roll, { port: p, ai });
      console.log(`GitRoll is open for ${bold(roll.config().name)}.`);
      console.log(dim(`If your browser didn't open, visit: ${url}`));
      console.log(dim("Keep this window open while you use GitRoll. Press Ctrl+C to close it."));
      if (browser) openBrowser(url);
      return;
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw lastError;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The link is printed above.
  }
}

function printSync(result: SyncResult, json?: boolean): void {
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.ok ? green(result.message) : red(result.message));
  if (!result.ok) process.exitCode = 1;
}

function githubRepoOf(roll: GitRoll): { owner: string; repo: string } {
  const { remote } = roll.status();
  const url = remote ? roll.git(["remote", "get-url", remote]).trim() : "";
  const repo = parseGitHubRemote(url);
  if (!repo) throw new UserError("Sharing works with Rolls backed up on GitHub. Run: gitroll backup");
  return repo;
}

/** `log "text" a.jpg b.pdf`: trailing arguments that are existing files become attachments. */
function splitTextAndFiles(args: string[], extra: string[] = []): { text: string; files: FileInput[] } {
  const words = [...args];
  const files: string[] = [...extra];
  while (words.length > 1 && fs.existsSync(words[words.length - 1]) && fs.statSync(words[words.length - 1]).isFile()) files.unshift(words.pop()!);
  return { text: words.join(" "), files: files.map(readFile) };
}

/** Makes the Roll the terminal app is on the one that opens next time. */
function rememberRoll(dir: string): void {
  const config = loadUserConfig();
  const hit = Object.entries(config.rolls).find(([, r]) => path.resolve(r.path) === path.resolve(dir));
  if (!hit) return;
  config.defaultRoll = hit[0];
  saveUserConfig(config);
}

/**
 * Unsaved composer drafts, one per Roll. They're kept with GitRoll's settings,
 * never inside a Roll, so an unfinished entry is never committed or synced.
 */
const draftFile = (rollRoot: string) => path.join(configDir(), "drafts", `${createHash("sha256").update(path.resolve(rollRoot)).digest("hex").slice(0, 16)}.json`);

const drafts = {
  load(rollRoot: string): Draft | null {
    try {
      return JSON.parse(fs.readFileSync(draftFile(rollRoot), "utf8")) as Draft;
    } catch {
      return null;
    }
  },
  save(rollRoot: string, draft: Draft): void {
    const file = draftFile(rollRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  },
  clear(rollRoot: string): void {
    fs.rmSync(draftFile(rollRoot), { force: true });
  },
};

/**
 * Hands the text to the person's own editor. The terminal app gives up the screen
 * while the editor has it, and takes it back afterwards.
 */
function editExternally(text: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new UserError("Set EDITOR (or VISUAL) to the editor you want, for example: export EDITOR=nano");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-entry-")), "entry.md");
  fs.writeFileSync(file, text, { mode: 0o600 });
  const wasRaw = !!process.stdin.isTTY && process.stdin.isRaw;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  if (wasRaw) process.stdin.setRawMode(false);
  try {
    const [command, ...args] = editor.split(/\s+/);
    const result = spawnSync(command, [...args, file], { stdio: "inherit" });
    if (result.error) throw new UserError(`Couldn't start ${editor}: ${result.error.message}`);
    const edited = fs.readFileSync(file, "utf8");
    return edited === text ? null : edited;
  } finally {
    if (wasRaw) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** Opens one of a Roll's own files in the person's editor, giving up the screen while it has it. */
function editFile(rollRoot: string, relativePath: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) throw new UserError("Set EDITOR (or VISUAL) to the editor you want, for example: export EDITOR=nano");
  const file = path.resolve(rollRoot, relativePath);
  if (!file.startsWith(path.resolve(rollRoot) + path.sep)) throw new UserError("That file isn't in this Roll.");
  const wasRaw = !!process.stdin.isTTY && process.stdin.isRaw;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  if (wasRaw) process.stdin.setRawMode(false);
  try {
    const [command, ...args] = editor.split(/\s+/);
    const result = spawnSync(command, [...args, file], { stdio: "inherit" });
    if (result.error) throw new UserError(`Couldn't start ${editor}: ${result.error.message}`);
  } finally {
    if (wasRaw) process.stdin.setRawMode(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l");
  }
}

function readFile(p: string): FileInput {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new UserError(`File not found: ${p}`);
  return { name: basename(p), type: mimeFor(extname(p)), data: fs.readFileSync(p) };
}

function amountArg(input: string): Amount {
  const amount = parseAmount(input);
  if (!amount) throw new UserError(`"${input}" isn't an amount. Try 325 or "$1,850".`);
  return amount;
}

/** A template by name, with the list when the name isn't one. */
function needTemplate(id: string) {
  const template = findTemplate(id);
  if (!template) throw new UserError(`There's no template called "${id}". Try one of: ${templateIds().join(", ")}`);
  return template;
}

/**
 * Hands text to $VISUAL or $EDITOR and returns what comes back. The file is a
 * real .md file in a temporary folder, so editors that key off the extension
 * (spell check, Markdown modes) behave normally.
 */
function openEditor(start: string, ext = ".md"): string {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    throw new UserError("Set $EDITOR (or $VISUAL) to the editor you want, for example: export EDITOR=nano");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-edit-"));
  const file = path.join(dir, `gitroll-event${ext}`);
  try {
    fs.writeFileSync(file, start);
    // Through a shell, so EDITOR="code -w" and EDITOR="vim -u NONE" both work.
    // The path is one GitRoll just made in a temporary folder, so quoting it is enough.
    const result = spawnSync(`${editor} ${JSON.stringify(file)}`, { stdio: "inherit", shell: true });
    if (result.error) throw new UserError(`Couldn't start your editor (${editor}): ${result.error.message}`);
    if (result.status !== 0) throw new UserError(`Your editor exited with ${result.status}. Nothing was saved.`);
    return fs.readFileSync(file, "utf8").replace(/\s+$/, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `@name` means a search someone saved earlier; anything else is the query itself. */
function savedQuery(query: string): string {
  const m = /^@([\w-]+)$/.exec(query.trim());
  if (!m) return query;
  const saved = loadUserConfig().searches?.[rollKey(m[1])];
  if (!saved) throw new UserError(`There's no saved search called "@${m[1]}". See: gitroll searches`);
  return saved;
}

/** The same search across every Roll on this computer. */
function findEverywhere(query: string, json: boolean | undefined): void {
  const config = loadUserConfig();
  const hits: { roll: string; entries: LoadedEntry[] }[] = [];
  for (const [key, { path: dir }] of Object.entries(config.rolls)) {
    if (!isRepo(dir)) continue;
    const roll = new GitRoll(dir);
    const found = searchRoll(roll, query);
    if (found.length) hits.push({ roll: key, entries: found });
  }
  if (json) return console.log(JSON.stringify(hits, null, 2));
  if (!hits.length) return console.log("Nothing found in any of your Rolls.");
  for (const { roll, entries } of hits) {
    console.log(bold(`${roll}  `) + dim(`${entries.length} ${entries.length === 1 ? "event" : "events"}`));
    for (const e of entries) printEntry(e, new Map());
  }
}

/** Two versions of the same event, beside each other, for settling a conflict. */
function printSideBySide(mine: string, theirs: string, width = Math.max(40, Math.min(process.stdout.columns ?? 100, 160))): void {
  const half = Math.floor((width - 3) / 2);
  const wrap = (text: string) =>
    text
      .split("\n")
      .flatMap((line) => (line.length <= half ? [line] : (line.match(new RegExp(`.{1,${half}}`, "g")) ?? [""])));
  const left = wrap(mine);
  const right = wrap(theirs);
  console.log(`  ${bold("Here".padEnd(half))} │ ${bold("From the other device")}`);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    console.log(`  ${(left[i] ?? "").padEnd(half)} │ ${right[i] ?? ""}`);
  }
}

/** Completion for commands, Roll names, saved searches and this Roll's tags. */
function completionScript(shell: string): string {
  const commands = [
    "ai", "ask", "backup", "check", "completion", "conflicts", "delete", "doctor", "edit", "export", "find", "forget",
    "help", "history", "import", "init", "join", "log", "menu", "move", "new", "open", "projects", "recent", "related",
    "remove", "rename", "resolve", "restore", "rolls", "searches", "setup", "share", "show", "status", "summary", "switch",
    "sync", "template", "templates", "today", "trust", "unshare", "untrust", "upgrade", "uninstall", "version",
  ].join(" ");
  if (shell === "bash") {
    return `# GitRoll completion for bash. Install with:
#   gitroll completion bash > /etc/bash_completion.d/gitroll   (or source it from ~/.bashrc)
_gitroll() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --roll|switch|forget|remove|open) COMPREPLY=($(compgen -W "$(gitroll __complete rolls 2>/dev/null)" -- "$cur")); return;;
    --template) COMPREPLY=($(compgen -W "$(gitroll __complete templates 2>/dev/null)" -- "$cur")); return;;
    -t|--tag) COMPREPLY=($(compgen -W "$(gitroll __complete tags 2>/dev/null)" -- "$cur")); return;;
    -p|--project) COMPREPLY=($(compgen -W "$(gitroll __complete projects 2>/dev/null)" -- "$cur")); return;;
    find) COMPREPLY=($(compgen -W "$(gitroll __complete searches 2>/dev/null)" -- "$cur")); return;;
  esac
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "${commands}" -- "$cur")); fi
}
complete -F _gitroll gitroll
`;
  }
  if (shell === "zsh") {
    return `# GitRoll completion for zsh. Install with:
#   gitroll completion zsh > "\${fpath[1]}/_gitroll"   (then restart your shell)
#compdef gitroll
_gitroll() {
  local -a commands
  commands=(${commands.split(" ").map((c) => `'${c}'`).join(" ")})
  case "\${words[CURRENT-1]}" in
    --roll|switch|forget|remove|open) compadd \${(f)"$(gitroll __complete rolls 2>/dev/null)"}; return;;
    --template) compadd \${(f)"$(gitroll __complete templates 2>/dev/null)"}; return;;
    -t|--tag) compadd \${(f)"$(gitroll __complete tags 2>/dev/null)"}; return;;
    -p|--project) compadd \${(f)"$(gitroll __complete projects 2>/dev/null)"}; return;;
    find) compadd \${(f)"$(gitroll __complete searches 2>/dev/null)"}; return;;
  esac
  if (( CURRENT == 2 )); then compadd $commands; fi
}
_gitroll "$@"
`;
  }
  if (shell === "fish") {
    return `# GitRoll completion for fish. Install with:
#   gitroll completion fish > ~/.config/fish/completions/gitroll.fish
complete -c gitroll -f
complete -c gitroll -n __fish_use_subcommand -a "${commands}"
complete -c gitroll -l roll -a "(gitroll __complete rolls)"
complete -c gitroll -l template -a "(gitroll __complete templates)"
complete -c gitroll -s t -l tag -a "(gitroll __complete tags)"
complete -c gitroll -s p -l project -a "(gitroll __complete projects)"
complete -c gitroll -n "__fish_seen_subcommand_from find" -a "(gitroll __complete searches)"
`;
  }
  throw new UserError(`GitRoll can complete for bash, zsh or fish. Not: ${shell}`);
}

/** What the completion scripts call. One name per line, and never an error. */
function completeList(what: string | undefined, dir: string | undefined, name: string | undefined): void {
  const config = loadUserConfig();
  const fromRoll = <T,>(read: (roll: GitRoll) => T[]): T[] => {
    try {
      return read(resolveRoll(dir, name));
    } catch {
      return [];
    }
  };
  const out =
    what === "rolls"
      ? Object.keys(config.rolls)
      : what === "searches"
        ? Object.keys(config.searches ?? {}).map((k) => `@${k}`)
        : what === "templates"
          ? templateIds()
          : what === "tags"
            ? fromRoll((roll) => facets(roll.entries()).tags.map(([t]) => t))
            : what === "projects"
              ? fromRoll((roll) => roll.projects())
              : what === "events"
                ? fromRoll((roll) => roll.entries().map((e) => eventName(e.path)))
                : [];
  for (const line of out) console.log(line);
}

function formatDay(date: string): string {
  const d = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  if (Number.isNaN(d.getTime())) return date;
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return date.length === 10 ? day : `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function formatAmount(a: Amount): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: a.currency }).format(a.value);
  } catch {
    return `${a.value} ${a.currency}`;
  }
}

function list(entries: LoadedEntry[], names: Map<string, string>, json: boolean | undefined, empty: string): void {
  if (json) return console.log(JSON.stringify(entries, null, 2));
  if (!entries.length) return console.log(empty);
  for (const e of entries) printEntry(e, names);
}

function printEntry(e: LoadedEntry, names: Map<string, string>): void {
  const when = e.date ? formatDay(e.date) : "Undated";
  const labels = e.projects.map((p) => names.get(p) ?? p).join(" · ");
  console.log(`${bold(when)}${labels ? `  ${labels}` : ""}  ${dim(eventName(e.path))}`);
  for (const line of (e.body || "(no text)").split("\n")) console.log(`  ${line}`);
  const bits = [e.amount ? formatAmount(e.amount) : "", e.attachments.length ? `${e.attachments.length} ${e.attachments.length === 1 ? "file" : "files"}` : "", e.tags.map((t) => `#${t}`).join(" ")].filter(Boolean);
  if (bits.length) console.log(dim(`  ${bits.join("  ·  ")}`));
  console.log();
}

/**
 * Ask needs three things to be true: it is set up, it is switched on, and the
 * Roll allows it. Each one has its own way out, so nobody has to guess which.
 */
function askableAi(roll: GitRoll): AiSettings {
  const config = loadUserConfig();
  if (!config.ai) {
    throw new UserError(
      "Ask isn't set up yet. With a model on this computer, nothing leaves it:\n" +
        Object.entries(AI_PRESETS)
          .filter(([, p]) => p.local)
          .map(([name, p]) => `  gitroll ai ${name.padEnd(10)} ${p.hint}`)
          .join("\n"),
    );
  }
  if (!aiOn(config.ai)) throw new UserError("Ask is switched off. Turn it back on with: gitroll ai on");
  if (!roll.config().aiAllowed) {
    throw new UserError(`Ask is turned off for this Roll (ai: false in ${roll.root}/.gitroll/config.yaml), so GitRoll won't read its events to a model.`);
  }
  return config.ai;
}

async function aiCommand(args: string[], v: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const [action, ...rest] = args;
  const config = loadUserConfig();
  const json = v.json === true;

  const show = async (test: boolean) => {
    const ai = config.ai;
    if (!ai) {
      if (json) return console.log(JSON.stringify({ configured: false, providers: AI_PRESETS }, null, 2));
      console.log("Ask answers questions from your own events. It isn't set up yet.\n");
      console.log(bold("On this computer") + dim("  nothing you log ever leaves it"));
      for (const [name, p] of Object.entries(AI_PRESETS).filter(([, p]) => p.local)) {
        console.log(`  ${bold(`gitroll ai ${name}`.padEnd(22))} ${p.label.padEnd(12)} ${dim(p.hint)}`);
      }
      console.log(`\n${bold("Somewhere else")}${dim("  your question and the matching events are sent over the internet")}`);
      for (const [name, p] of Object.entries(AI_PRESETS).filter(([, p]) => !p.local)) {
        console.log(`  ${bold(`gitroll ai ${name}`.padEnd(22))} ${p.label.padEnd(12)} ${dim(p.hint)}`);
      }
      console.log(dim("\nAPI keys are read from environment variables. GitRoll never stores a key, and never puts one in a Roll."));
      return;
    }
    const check = test ? await testConnection(ai) : null;
    if (json) return console.log(JSON.stringify({ configured: true, enabled: aiOn(ai), ...ai, local: isLocalEndpoint(ai.endpoint), check }, null, 2));
    console.log(`${bold(ai.model)} at ${ai.endpoint}${ai.provider ? dim(`  (${AI_PRESETS[ai.provider]?.label ?? ai.provider})`) : ""}`);
    console.log(isLocalEndpoint(ai.endpoint) ? green(privacyNote(ai)) : yellow(privacyNote(ai)));
    if (ai.apiKeyEnv) {
      console.log(process.env[ai.apiKeyEnv] ? dim(`Key: read from ${ai.apiKeyEnv}, which is set here.`) : yellow(`Key: ${ai.apiKeyEnv} isn't set in this terminal.`));
    }
    if (!aiOn(ai)) console.log(yellow("Switched off. Turn it back on with: gitroll ai on"));
    if (check) console.log(check.ok ? green(`✓ ${check.message}`) : red(`✗ ${check.message}`));
    if (!test) console.log(dim("\nCheck it works: gitroll ai test"));
  };

  if (!action) return show(false);

  if (action === "test") {
    if (!config.ai) throw new UserError("There's nothing to test yet. Set a model up first: gitroll ai");
    const check = await testConnection(config.ai);
    if (json) return console.log(JSON.stringify(check, null, 2));
    console.log(check.ok ? green(`✓ ${check.message}`) : red(`✗ ${check.message}`));
    if (check.ok) console.log(dim(`Ready: ${bold('gitroll ask "What did I ship last week?"')}`));
    if (!check.ok) process.exitCode = 1;
    return;
  }

  if (action === "on" || action === "off") {
    if (!config.ai) throw new UserError("Ask isn't set up yet. See: gitroll ai");
    config.ai.enabled = action === "on";
    saveUserConfig(config);
    return console.log(action === "on" ? green("Ask is on.") : "Ask is off. Your settings are kept, so `gitroll ai on` brings it back.");
  }

  if (action === "forget") {
    delete config.ai;
    saveUserConfig(config);
    return console.log("Forgot the AI settings. Nothing in your Rolls changed.");
  }

  let settings: AiSettings;
  if (action === "custom") {
    settings = {
      endpoint: need(v.endpoint as string | undefined, "gitroll ai custom --endpoint <url> --model <name>"),
      model: need(v.model as string | undefined, "gitroll ai custom --endpoint <url> --model <name>"),
      apiKeyEnv: (v["api-key-env"] as string | undefined) || undefined,
      allowRemote: v["allow-remote"] === true || undefined,
    };
  } else {
    const preset = AI_PRESETS[action];
    if (!preset) throw new UserError(`Choose one of: ${Object.keys(AI_PRESETS).join(", ")}, custom, test, on, off, forget`);
    settings = {
      provider: action,
      endpoint: (v.endpoint as string | undefined) || preset.endpoint,
      model: (rest[0] as string | undefined) || (v.model as string | undefined) || preset.model,
      apiKeyEnv: (v["api-key-env"] as string | undefined) || preset.apiKeyEnv,
      allowRemote: preset.local ? undefined : true,
    };
  }
  if (!isLocalEndpoint(settings.endpoint) && !settings.allowRemote) {
    throw new UserError("That address isn't on this computer. To send questions and matching events there, add --allow-remote.");
  }
  settings.enabled = true;
  config.ai = settings;
  saveUserConfig(config);

  console.log(green(`Ask will use ${bold(settings.model)}.`));
  console.log(isLocalEndpoint(settings.endpoint) ? dim(privacyNote(settings)) : yellow(privacyNote(settings)));
  if (settings.apiKeyEnv && !process.env[settings.apiKeyEnv]) {
    console.log(yellow(`Set your key first: export ${settings.apiKeyEnv}=…`));
  }
  const check = await testConnection(settings);
  console.log(check.ok ? green(`✓ ${check.message}`) : red(`✗ ${check.message}`));
  if (check.ok) console.log(`Try it: ${bold('gitroll ask "What did I ship last week?"')}`);
}

async function doctor(dir?: string, name?: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const ok = (m: string) => console.log(`${green("✓")} ${m}`);
  const warn = (m: string) => console.log(`${yellow("!")} ${m}`);
  const bad = (m: string) => {
    console.log(`${red("✗")} ${m}`);
    process.exitCode = 1;
  };
  const cmd = (c: string, a: string[]) => {
    try {
      return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };

  const gitVersion = cmd("git", ["--version"]);
  gitVersion ? ok(gitVersion) : bad("Git isn't installed: https://git-scm.com/downloads");
  Number(process.versions.node.split(".")[0]) >= 20 ? ok(`Node.js ${process.versions.node}`) : bad("GitRoll needs Node.js 20 or newer.");
  hasGh() ? (ghSignedIn() ? ok("GitHub CLI signed in") : warn("GitHub CLI isn't signed in (needed for backup and share): gh auth login")) : warn("GitHub CLI not installed (optional; makes backup and sharing one command): https://cli.github.com");

  let roll: GitRoll;
  try {
    roll = resolveRoll(dir, name);
  } catch (e) {
    return warn((e as Error).message);
  }
  console.log(bold(`\n${roll.config().name}`) + dim(`  ${roll.root}`));
  const problems = roll.check();
  problems.length ? bad(`${problems.length} ${problems.length === 1 ? "problem" : "problems"} in the Roll (run: gitroll check)`) : ok("Roll files are valid and attachments are intact");
  const sensitive = roll.sensitive();
  sensitive.length ? warn(`${sensitive.length} ${sensitive.length === 1 ? "event looks" : "events look"} like it contains passwords, keys or card numbers (run: gitroll check)`) : ok("No passwords, keys or card numbers spotted");
  roll.config().removeLocation ? ok("Location data is removed from new photos") : warn("Location data is kept in photos (attachments.remove_location is false)");

  const status = roll.status();
  if (!status.remote) warn("Not backed up. If this computer is lost, so is the Roll. Run: gitroll backup");
  else {
    const trusted = new Set((loadUserConfig().trustedRemotes ?? []).map((t) => t.toLowerCase()));
    for (const url of roll.pushDestinations()) {
      const shown = displayRemote(url);
      if (/^https?:\/\/[^/]*@/.test(url)) bad(`The backup address ${shown} contains a password or token. Use SSH or the GitHub CLI instead.`);
      if (isLocalDestination(url)) {
        ok(`Backs up to a folder on this computer (${shown})`);
        continue;
      }
      const github = parseGitHubRemote(url);
      if (!github) {
        if (trusted.has(shown.toLowerCase())) warn(`${shown} isn't on GitHub, so its privacy can't be checked. You chose to trust it.`);
        else bad(`${shown} isn't on GitHub, so its privacy can't be checked and sync won't upload. If it's private, run: gitroll trust ${shown}`);
        continue;
      }
      const visibility = await githubVisibility(github.owner, github.repo);
      if (visibility === "public") bad(`${shown} is PUBLIC. Anyone can read this Roll. Make it private now.`);
      else if (visibility === "not-public") ok(`${shown} isn't public`);
      else warn(`Couldn't confirm ${shown} is private (offline?). Sync won't upload until it can.`);
    }
    status.ahead ? warn(`${status.ahead} changes haven't been synced`) : ok("Synced");
  }

  const email = cmd("git", ["-C", roll.root, "config", "user.email"]);
  if (email && !/noreply\.github\.com$/.test(email)) {
    warn(`Your email (${email}) is recorded in the Roll's history and visible to anyone you share with. GitHub's private noreply address avoids this: https://github.com/settings/emails`);
  }
  cmd("git", ["-C", roll.root, "config", "commit.gpgsign"]) === "true" ? ok("Changes are signed") : console.log(dim("  Tip: sign changes to prove who made them: https://docs.github.com/authentication/managing-commit-signature-verification"));

  const ai = loadUserConfig().ai;
  if (!ai) console.log(dim("  Ask isn't set up. To answer questions from your own events with a model on this computer: gitroll ai"));
  else if (!aiOn(ai)) console.log(dim(`  Ask is switched off (${ai.model}). Turn it on with: gitroll ai on`));
  else if (isLocalEndpoint(ai.endpoint)) ok(`Ask uses a model on this computer (${ai.model}); nothing you log leaves it`);
  else warn(privacyNote(ai));

  if (process.platform !== "win32") {
    try {
      const mode = fs.statSync(path.join(configDir(), "config.json")).mode & 0o077;
      mode ? warn(`Your settings file can be read by other users: chmod 600 ${path.join(configDir(), "config.json")}`) : ok("Settings file is private to you");
    } catch {
      // no settings file yet
    }
  }
  console.log(dim("\nGitRoll keeps no copy of your data. Files aren't encrypted: anyone with access to this computer or the GitHub repository can read them."));
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(red(err instanceof UserError ? err.message : (err.stack ?? err.message)));
  process.exitCode = 1;
});
