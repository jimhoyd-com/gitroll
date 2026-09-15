#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { planIngest, withDefaults } from "../core/adapter.ts";
import { ADAPTERS, getAdapter } from "../core/adapters/index.ts";
import type { Amount } from "../core/entry.ts";
import type { EntryChanges, LoadedEntry } from "../core/layout.ts";
import { SearchIndex } from "../core/search.ts";
import { typeRegistry } from "../core/types.ts";
import type { FieldDef, FieldKind } from "../core/types.ts";
import { UserError, basename, extname, mimeFor, parseAmount } from "../core/util.ts";
import { AI_PRESETS, askRoll, isLocalEndpoint } from "./ai.ts";
import { gh, ghSignedIn, githubVisibility, hasGh, parseGitHubRemote } from "./github.ts";
import { GitRoll, displayRemote, findRepoRoot, isLocalDestination, isRepo } from "./repo.ts";
import type { FileInput, SyncResult } from "./repo.ts";
import { serve } from "./server.ts";
import { parsePaths, runTui, tuiSupported } from "./tui.ts";
import { addRoll, configDir, experimental, findRoll, loadUserConfig, rollKey, rollsHome, saveUserConfig } from "./user-config.ts";

const HELP = `GitRoll: log what happened, find it later.

  gitroll                      Open GitRoll (the terminal app; press o for the browser)
  gitroll menu  (or gitroll -i) Full-screen app: arrow keys to browse, n to log, / to find
  gitroll setup                Create your first Roll (a private logbook)
  gitroll log "what happened"  Log something. Add photos or receipts after the text:
                                 gitroll log "AC serviced, $325" invoice.pdf
  gitroll find "words"         Find events
  gitroll sync                 Back up and get changes from others
  gitroll rolls                List your Rolls (switch with: gitroll switch <name>)
  gitroll share <github-user>  Let someone else log in this Roll

  gitroll help more            Everything else
`;

const MORE = `More GitRoll commands

Rolls
  rolls add [folder]           Add a Roll you cloned yourself (for example, one made from the template)
  new <name> [--github] [--template <folder|owner/repo>]
                               Create a Roll (with --github, also a private GitHub backup)
  join <owner/repo | url>      Download a Roll someone shared with you
  switch <name>                Make a Roll the one GitRoll uses by default
  rename <new name>            Rename the current Roll
  backup [git url]             Connect the current Roll to a private GitHub repository
  forget <name>                Remove a Roll from this list (files stay)
  remove <name> --delete-files Delete a Roll's folder from this computer (GitHub copy stays)
  status                       What's saved, what still needs syncing

Events
  log "text" [files] [--type <type>] [-p <project>] [-t <tag>] [--amount <amount>] [--at <when>] [-d key=value]
  find "words"                 Also: project:house tag:payment type:expense after:2026-01-01 amount:>500 has:receipt
  today | recent [-n 20]       Events from today, or the latest ones
  show <id> | history <id>     One event, or every change made to it
  edit <id> [--text ..] [--type ..] [--amount ..|none] [-p ..] [-t ..] [files]
  delete <id>                  Remove an event from the timeline (history keeps it)

Organize
  projects [add <name> | remove <name>]
  types [add <name> [--field key:kind]... | remove <name>]
                               kinds: text, longtext, number, date, select, boolean, url
  template <folder>            Save this Roll's types, projects and theme as a template

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
const shortId = (id: string) => id.replace(/-/g, "").slice(-8);

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
      type: { type: "string" },
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
    },
  });
  const [command = "", ...args] = all;
  if (v.plain) tty = false;

  if (v.help || command === "help") {
    process.stdout.write(args[0] === "more" || args[0] === "all" ? MORE : HELP);
    return;
  }

  const openRoll = () => resolveRoll(v.repo, v.roll);
  const names = (roll: GitRoll) => new Map(roll.projects().map((p) => [p.slug, p.name]));

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
          throw new UserError(`${dir} isn't a Roll (there's no .gitroll/config.yaml), so GitRoll won't change it.`);
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
      if (v.json) return console.log(JSON.stringify({ name: roll.config().name, path: roll.root, events: entries.length, problems: problems.length, ...status }, null, 2));
      console.log(bold(roll.config().name) + dim(`  ${roll.root}`));
      console.log(`${entries.length} events${entries[0] ? `, latest ${entries[0].occurred.slice(0, 10)}` : ""}`);
      if (!status.remote) console.log(yellow("Not backed up yet. Run: gitroll backup"));
      else if (status.ahead) console.log(yellow(`${status.ahead} ${status.ahead === 1 ? "change" : "changes"} to sync with ${status.remoteUrl}. Run: gitroll sync`));
      else console.log(green(`Synced with ${status.remoteUrl}`));
      if (status.dirty) console.log(dim("Some files were edited outside GitRoll and aren't saved to history yet."));
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
      const { entry, notices } = roll.save(
        { text: body, type: v.type, occurred: v.at, projects: v.project, tags: v.tag, data: v.data ? pairs(v.data) : undefined, amount: v.amount ? amountArg(v.amount) : undefined },
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
      const query = need(args.join(" "), 'gitroll find "words"');
      const registry = typeRegistry(roll.types());
      const index = new SearchIndex(roll.entries(), { projectNames: names(roll), typeLabels: new Map([...registry.values()].map((t) => [t.id, t.label])) });
      return list(index.search(query), names(roll), v.json, "Nothing found.");
    }
    case "today": {
      const roll = openRoll();
      const today = new Date().toDateString();
      return list(roll.entries().filter((e) => new Date(e.occurred).toDateString() === today), names(roll), v.json, "Nothing logged today.");
    }
    case "recent":
    case "timeline": {
      const roll = openRoll();
      return list(roll.entries().slice(0, Number(v.limit ?? 20)), names(roll), v.json, 'Nothing logged yet. Try: gitroll log "Started using GitRoll"');
    }
    case "show": {
      const roll = openRoll();
      const e = roll.entry(need(args[0], "gitroll show <id>"));
      if (v.json) return console.log(JSON.stringify(e, null, 2));
      printEntry(e, names(roll));
      for (const [key, value] of Object.entries(e.data)) console.log(`  ${dim(key)}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
      for (const a of e.attachments) {
        const file = roll.attachmentFile(a.hash);
        console.log(`  ${a.name}  ${dim(file ? path.relative(process.cwd(), file) : "(missing)")}`);
      }
      console.log(dim(`  Logged by ${e.author} on ${e.created.slice(0, 16).replace("T", " ")} · ${e.path}`));
      return;
    }
    case "edit": {
      const roll = openRoll();
      const [id, ...rest] = args;
      const { files } = splitTextAndFiles(["", ...rest], v.file);
      const changes: EntryChanges = { text: v.text, type: v.type, occurred: v.at, projects: v.project, tags: v.tag };
      if (v.data) changes.data = pairs(v.data);
      if (v.amount !== undefined) changes.amount = v.amount === "none" ? null : amountArg(v.amount);
      const { entry, notices } = roll.saveChanges(need(id, "gitroll edit <id> --text \"...\""), changes, files);
      if (v.json) return console.log(JSON.stringify({ entry, notices }, null, 2));
      console.log(green("Saved. The earlier version is kept in history."));
      printEntry(entry, names(roll));
      for (const n of notices) console.log(yellow(n));
      return;
    }
    case "delete":
    case "rm": {
      const roll = openRoll();
      const e = roll.entry(need(args[0], "gitroll delete <id>"));
      printEntry(e, names(roll));
      if (!(await confirm("Delete this event? Its history is kept.", v.yes))) return;
      roll.deleteEntry(e.id);
      return console.log("Deleted. It's still in the Roll's history.");
    }
    case "history": {
      const roll = openRoll();
      const items = roll.history(need(args[0], "gitroll history <id>"));
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
      const [action, ...rest] = args;
      if (action === "add") return console.log(`Added the project ${bold(roll.createProject(need(rest.join(" "), "gitroll projects add <name>")).name)}.`);
      if (action === "remove") {
        roll.deleteProject(need(rest.join(" "), "gitroll projects remove <name>"));
        return console.log("Removed the project.");
      }
      const entries = roll.entries();
      const projects = roll.projects();
      if (v.json) return console.log(JSON.stringify(projects, null, 2));
      if (!projects.length) return console.log('No projects yet. Add one: gitroll projects add "House"');
      for (const p of projects) console.log(`${bold(p.name.padEnd(28))} ${dim(`${entries.filter((e) => e.projects.includes(p.slug)).length} events`)}`);
      return;
    }
    case "types": {
      const roll = openRoll();
      const [action, ...rest] = args;
      if (action === "add") {
        const t = roll.createType(need(rest.join(" "), 'gitroll types add "Vehicle service" --field odometer:number'), (v.field ?? []).map(fieldArg));
        return console.log(`Added the type ${bold(t.label)}.`);
      }
      if (action === "remove") {
        roll.deleteType(need(rest.join(" "), "gitroll types remove <name>"));
        return console.log("Removed the type. Events that used it keep their details.");
      }
      const types = [...typeRegistry(roll.types()).values()];
      if (v.json) return console.log(JSON.stringify(types, null, 2));
      for (const t of types) console.log(`${bold(t.label.padEnd(18))} ${dim(`${t.builtin ? "built in" : "custom"}${t.fields.length ? ` · ${t.fields.map((f) => f.label).join(", ")}` : ""}`)}`);
      return;
    }
    case "template": {
      const roll = openRoll();
      const files = roll.exportTemplate(need(args[0], "gitroll template <folder>"));
      console.log(`Saved a template with ${files.length} files to ${path.resolve(args[0])}.`);
      return console.log(dim(`Create a Roll from it: gitroll new "Name" --template ${args[0]}`));
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

    // ── AI ──────────────────────────────────────────────────────────────────
    case "ai":
      if (!experimental("ai")) throw new UserError(`"ai" isn't a GitRoll command. See: gitroll help`);
      return aiCommand(args[0], v);
    case "ask": {
      if (!experimental("ai")) throw new UserError(`"ask" isn't a GitRoll command. See: gitroll help`);
      const roll = openRoll();
      const question = need(args.join(" "), 'gitroll ask "When was the AC last serviced?"');
      const ai = loadUserConfig().ai;
      if (!ai) throw new UserError("Ask needs an AI model on this computer. Set one up: gitroll ai ollama");
      if (!roll.config().aiAllowed) throw new UserError("Ask is turned off for this Roll.");
      const { answer, sources } = await askRoll(ai, roll.entries(), question, names(roll));
      if (v.json) return console.log(JSON.stringify({ answer, sources: sources.map((e) => e.id) }, null, 2));
      console.log(answer);
      if (sources.length) {
        console.log(dim("\nFrom these events:"));
        for (const e of sources) printEntry(e, names(roll));
      }
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
  known.forEach((p, i) => console.log(`  ${i + 1}  ${p.name}`));
  const pick = await ui.ask(known.length ? "Project? Type a number or a new name, or press Enter to skip:" : "Project? Type a name, or press Enter to skip:");
  let projects: string[] = [];
  if (pick && pick !== QUIT) {
    if (/^\d+$/.test(pick)) {
      const chosen = known[Number(pick) - 1];
      if (chosen) projects = [chosen.slug];
      else console.log(dim(`There's no project ${pick}; logging without one.`));
    } else projects = [pick];
  }
  const { entry, notices } = roll.save({ text, projects }, files);
  console.log(green("Logged."));
  printEntry(entry, projectNamesOf(roll));
  for (const n of notices) console.log(yellow(n));
}

function projectNamesOf(roll: GitRoll): Map<string, string> {
  return new Map(roll.projects().map((p) => [p.slug, p.name]));
}

function searchRoll(roll: GitRoll, query: string): LoadedEntry[] {
  const registry = typeRegistry(roll.types());
  return new SearchIndex(roll.entries(), {
    projectNames: projectNamesOf(roll),
    typeLabels: new Map([...registry.values()].map((t) => [t.id, t.label])),
  }).search(query);
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
          return Object.entries(config.rolls).filter(([, r]) => isRepo(r.path)).map(([key, r]) => ({ key, name: key, path: r.path }));
        },
        openRoll: (p) => new GitRoll(p),
        readFile,
        openInBrowser: async (r) => {
          const { server, url } = await serve(r, { port: port ? Number(port) : 0, ai: experimental("ai") ? (loadUserConfig().ai ?? null) : null });
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
 * Plain `gitroll`: open the Roll you're in (checking its shape), offer to set up an empty
 * folder, refuse to touch a repository that has other files, otherwise open the default Roll.
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
  if (isBlankFolder(cwd)) {
    const rollName = path.basename(cwd);
    if (!yes && !process.stdin.isTTY) return console.log(`This folder is empty. To make it a Roll, run: gitroll init`);
    if (!(await confirm(`This folder is empty. Make it a Roll called "${rollName}"?`, yes))) return;
    const roll = GitRoll.init(cwd, { name: rollName });
    const { key } = registerRoll(roll.root);
    console.log(green(`Created the Roll "${rollName}" (${key}).`) + (roll.status().remote ? ` Back it up with: ${bold("gitroll sync")}` : ""));
    return openApp(roll, port, browser);
  }
  if (fs.existsSync(path.join(cwd, ".git"))) {
    throw new UserError(`This repository has files but isn't a Roll, so GitRoll won't change it. Run gitroll inside a Roll or an empty folder, or create one with: gitroll new "Name"`);
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

async function openWebApp(roll: GitRoll, port: string | undefined, browser: boolean): Promise<void> {
  const ai = experimental("ai") ? (loadUserConfig().ai ?? null) : null;
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

function readFile(p: string): FileInput {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new UserError(`File not found: ${p}`);
  return { name: basename(p), type: mimeFor(extname(p)), data: fs.readFileSync(p) };
}

function amountArg(input: string): Amount {
  const amount = parseAmount(input);
  if (!amount) throw new UserError(`"${input}" isn't an amount. Try 325 or "$1,850".`);
  return amount;
}

function pairs(items: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const item of items) {
    const i = item.indexOf("=");
    if (i < 1) throw new UserError(`Use key=value, for example -d vendor="Cool Air" (got ${item})`);
    data[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return data;
}

function fieldArg(spec: string): FieldDef {
  const [label, kind = "text"] = spec.split(":");
  const kinds: FieldKind[] = ["text", "longtext", "number", "date", "select", "boolean", "url"];
  if (!kinds.includes(kind as FieldKind)) throw new UserError(`Field kinds: ${kinds.join(", ")}`);
  const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(key)) throw new UserError(`Field names must start with a letter: ${spec}`);
  return { key, label: label.trim(), kind: kind as FieldKind };
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
  const d = new Date(e.occurred);
  const when = `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  const labels = [e.type !== "log" ? e.type : "", ...e.projects.map((p) => names.get(p) ?? p)].filter(Boolean).join(" · ");
  console.log(`${bold(when)}${labels ? `  ${labels}` : ""}  ${dim(shortId(e.id))}`);
  for (const line of (e.body || "(no text)").split("\n")) console.log(`  ${line}`);
  const bits = [e.amount ? formatAmount(e.amount) : "", e.attachments.length ? `${e.attachments.length} ${e.attachments.length === 1 ? "file" : "files"}` : "", e.tags.map((t) => `#${t}`).join(" ")].filter(Boolean);
  if (bits.length) console.log(dim(`  ${bits.join("  ·  ")}`));
  console.log();
}

async function aiCommand(action: string | undefined, v: Record<string, string | boolean | string[] | undefined>): Promise<void> {
  const config = loadUserConfig();
  if (!action) {
    if (!config.ai) {
      console.log("Ask isn't set up. GitRoll can use an AI model running on this computer:");
      for (const [name, preset] of Object.entries(AI_PRESETS)) console.log(`  ${bold(`gitroll ai ${name}`.padEnd(22))} ${dim(preset.hint)}`);
      return;
    }
    console.log(`Model: ${bold(config.ai.model)} at ${config.ai.endpoint}`);
    console.log(isLocalEndpoint(config.ai.endpoint) ? green("Local: your events stay on this computer.") : yellow("Remote: questions and matching events are sent to this address."));
    return;
  }
  if (action === "off") {
    delete config.ai;
    saveUserConfig(config);
    return console.log("Ask is turned off.");
  }
  let settings;
  if (action === "custom") {
    settings = {
      endpoint: need(v.endpoint as string | undefined, "gitroll ai custom --endpoint <url> --model <name>"),
      model: need(v.model as string | undefined, "gitroll ai custom --endpoint <url> --model <name>"),
      apiKeyEnv: (v["api-key-env"] as string | undefined) || undefined,
      allowRemote: v["allow-remote"] === true || undefined,
    };
  } else {
    const preset = AI_PRESETS[action];
    if (!preset) throw new UserError(`Choose one of: ${Object.keys(AI_PRESETS).join(", ")}, custom, off`);
    settings = { endpoint: preset.endpoint, model: (v.model as string | undefined) || preset.model };
  }
  if (!isLocalEndpoint(settings.endpoint) && !settings.allowRemote) {
    throw new UserError("That address isn't on this computer. To send questions and matching events there, add --allow-remote.");
  }
  config.ai = settings;
  saveUserConfig(config);
  console.log(green(`Ask will use ${settings.model}.`) + ` Try: ${bold('gitroll ask "What did I spend on the house this year?"')}`);
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

  const ai = experimental("ai") ? loadUserConfig().ai : undefined;
  if (ai) isLocalEndpoint(ai.endpoint) ? ok(`Ask uses a local model (${ai.model})`) : warn(`Ask sends questions and matching events to ${ai.endpoint}`);

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
