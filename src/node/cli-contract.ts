import { AuthError, ConflictError, NotFoundError, UserError } from "../core/util.ts";
import type { LoadedEntry } from "../core/layout.ts";
import { CLI_OPTIONS } from "./cli-options.ts";

export class CliError extends UserError {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type Values = Record<string, string | boolean | string[] | undefined>;
/** mcp: false keeps a JSON command off the MCP server (see mcp.ts). */
type Command = { args: string; flags: string; effect: string; output: string; max?: number; json?: false; mcp?: false };
const read = (args: string, output: string, flags = "", max = 0): Command => ({ args, flags, effect: "read", output, max });
const write = (args: string, output: string, flags = "", max?: number): Command => ({ args, flags, effect: "local write", output, max });
const roll = "repo roll";
const paging = "limit offset fields";
export const COMMANDS: Record<string, Command> = {
  "": { args: "", flags: `${roll} port no-browser yes`, effect: "interactive; may initialize a Roll; starts server and optionally browser", output: "local web server", max: 0, json: false },
  help: read("[command|more|agent]", "{text} or agent guide or command schema", "", 1),
  schema: read("[command]", "{schemaVersion, globals, commands, error, entryFields}", "", 1),
  version: read("", "{version, method, ...installation details}"),
  open: { ...read("[name]", "local web server", `${roll} port no-browser`, 1), effect: "starts server and optionally browser", json: false },
  setup: { ...write("", "interactive setup", "yes", 0), json: false },
  new: { ...write("<name...>", "{name, path}", "dir template github owner"), effect: "local write; --github creates and pushes to a private repository; remote --template downloads files" },
  init: { ...write("[name...]", "{name, path}", "dir template github owner"), effect: "local write; --github creates and pushes to a private repository; remote --template downloads files" },
  join: { ...write("<source> [name]", "{name, path}", "", 2), effect: "network read; local write" },
  rolls: { ...read("[add [folder]]", "Roll[] or {key, path, added, problems}", "", 2), effect: "read; add writes settings" },
  switch: write("<name>", "{defaultRoll}", "", 1),
  rename: write("<name...>", "{name}", roll),
  forget: write("<name>", "{forgotten}", "", 1),
  remove: write("<name>", "{deleted}", "delete-files yes", 1),
  backup: { ...write("[url]", "sync result {ok, code, message, ...}", `${roll} owner yes`, 1), effect: "network read/write; may create a private GitHub repository" },
  status: read("", "{name, path, events, problems, template, ...Git status}", roll),
  capture: { ...write("", "capture window", `${roll} no-window`, 0), effect: "interactive; opens a small window and writes an event when you save", json: false },
  inbox: { ...write("[name]", "{inbox, name, path, embedded} or {inbox}", "", 1), effect: "read; a name writes settings" },
  shortcut: { ...write("[keys|off]", "{status, shortcut, mechanism, message, steps, conflicts}", "dry-run", 1), effect: "read; keys or off change this computer's desktop keyboard settings unless --dry-run" },
  log: write("[text...] [files...]", "{entry, notices, replayed?}", `${roll} title editor template code project tag file at amount idempotency-key`),
  find: { ...read("<query...>", "Entry[]; --all returns {roll, entries: Entry[]}[]", `${roll} save all sort ${paging}`, Infinity), effect: "read; --save writes settings" },
  today: read("", "Entry[]", `${roll} ${paging}`),
  recent: read("", "Entry[]", `${roll} ${paging}`),
  show: read("<file>", "Entry with revision (SHA-256 of file contents); sealed parts listed in sealed: {sealed: true, kind, lines|field}[] and sealed fields as {sealed: true}", `${roll} unsealed`, 1),
  edit: write("<file> [files...]", "{entry, notices}", `${roll} text title editor project tag file at amount expect`),
  delete: write("<file>", "{deleted: path}", `${roll} yes`, 1),
  history: read("<file>", "{commit, author, date, subject, patch}[]", roll, 1),
  projects: read("", "string[]", roll),
  restore: write("<file> [commit]", "{entry, from, unchanged} or {entry} when the event itself was deleted", roll, 2),
  deleted: read("", "{path, title, date, deletedAt, commit}[]", `${roll} limit`),
  undelete: write("<file>", "{entry}", roll, 1),
  related: read("<file>", "{links: string[], backlinks: string[], missing: string[]}", roll, 1),
  notes: read("[words...]", "Entry[] (notes, by title)", `${roll} ${paging}`, Infinity),
  note: write("<title> [text...]", "{entry, notices}", `${roll} editor project tag`, Infinity),
  records: read("[collection] [query...]", "{name, path, records, description}[], or with a collection {collection, description, columns, total, records: {path, title, fields}[]}; --csv prints RFC 4180 CSV (with --json, {collection, csv})", `${roll} sort csv ${paging}`, Infinity),
  set: write("<file|query> [key=value...]", "{entry, notices, changed}; a path under files/ sets fields in that file's sidecar", `${roll} unset expect`, Infinity),
  files: { ...read("[query...]", "{path, title, size, parts, sidecar, revision, fields, linkedFrom, unfiled, missing}[]", `${roll} unfiled open limit offset`, Infinity), effect: "read; --open <file> opens one in this computer's app (a file in parts is joined into a temporary folder and checked first)" },
  reassemble: { ...write("<file>", "{path, out, size, parts, sha256, verified}", `${roll} out`, 1), effect: "writes one new file at --out on this computer (never overwrites); joins a file kept in parts and checks its sha256" },
  attach: { ...write("<path>", "{path, size, parts, sha256, sidecar, linkedFrom, notices}", `${roll} to field`, 1), effect: "local write; reads only the one file on this computer that <path> names" },
  add: write("<collection> <title> [text...]", "{entry, notices, replayed?}", `${roll} field idempotency-key`, Infinity),
  todos: read("[query...]", "{path, line, text, done, title, derived?}[]; open only unless --all; derived restock to-dos (line 0, derived: true) come from quantity <= reorderAt and are not written anywhere", `${roll} all`, Infinity),
  todo: write("<text...>", "{todo: {path, line, text, done}, entry}", `${roll} to`, Infinity),
  done: write("<words|file:line>", "{todo: {path, line, text, done}, entry, next?}; next is the new to-do added when a 🔁 recurring one is done", roll, Infinity),
  undone: write("<words|file:line>", "{todo: {path, line, text, done}, entry}", roll, Infinity),
  conflicts: read("", "Conflict[]", roll),
  resolve: write("<file>", "Entry", `${roll} mine theirs editor`, 1),
  templates: read("", "Template[]; this Roll's own first, then the built-ins it keeps", roll),
  searches: { ...read("[remove <name>]", "{name: query} or {removed}", "", 2), effect: "read; remove writes settings" },
  completion: { ...read("<bash|zsh|fish>", "shell script", "", 1), json: false },
  __complete: { ...read("<kind>", "completion candidates", roll, 1), json: false },
  move: write("<file> <new-path>", "Entry", roll, 2),
  template: { ...read("[set <version>]", "TemplateStatus", `${roll} set`, 2), effect: "read; set writes a commit" },
  sync: { ...write("", "{ok, code, message, uncommittedLog, ...sync details}", `${roll} yes`, 0), effect: "network read/write; local write; pushes the whole branch, code included (--yes confirms when pending commits are not log records)" },
  save: { ...write("", "{committed: string[]}", roll, 0), effect: "local write; commits changed files under .gitroll/ only" },
  share: { ...write("[user]", "Collaborator[] or {invited, permission}", `${roll} read-only`, 1), effect: "network read; user argument grants access" },
  trust: write("[address]", "string[] or {trusted}", "yes", 1),
  untrust: write("<address>", "{untrusted}", "", 1),
  unshare: { ...write("<user>", "{removed}", roll, 1), effect: "revokes remote access" },
  check: read("", "{problems, sensitive}; exit 1 when problems exist", roll),
  doctor: { ...read("", "{checks: {level, message}[]}; exit 1 for failed checks", roll), effect: "local and network reads to check setup and backup visibility" },
  export: read("", "{roll, exported, events: Entry[]}, Markdown with --format markdown, or {output, format}", `${roll} format output`),
  import: { ...write("<github|ci|webhook|csv> [source] [file.csv]", "{created, skipped} or --dry-run {create, skip}; csv: {collection, created, skipped, problems}", `${roll} since until include only author label status branch project tag limit dry-run`, 3), effect: "network read for GitHub/CI; writes events (csv: records) unless --dry-run" },
  upgrade: { ...write("", "installer output", "yes dry-run", 0), effect: "network access; installs software unless --dry-run", json: false },
  uninstall: { ...write("", "uninstaller output", "yes dry-run remove-settings", 0), json: false },
  mcp: { ...read("", "Model Context Protocol (JSON-RPC 2.0) messages on stdout", roll, 0), effect: "serves every JSON command as an MCP tool over stdio; each call has that command's effect", json: false },
  upcoming: read("", "{date, kind, title, path, end?, location?, rrule?, field?, line?, text?, recurrence?, overdue?}[] by date", `${roll} days`),
  calendar: read("", "the same items as upcoming, unbounded; --ics returns RFC 5545 text (with --json, {ics})", `${roll} ics`),
  ledger: read("[query...]", "{by, totals: {currency, total, count}[], groups: {key, totals, count}[], entries: {date, title, path, amount, field, projects, tags}[]}; --hledger returns a journal (with --json, {journal})", `${roll} by hledger`, Infinity),
  inventory: read("[query...]", "{collection, items, totals, groups?, warranties, restock}", `${roll} by collection`, Infinity),
  series: read("<field> [query...]", "{field, by, points: {date, value, currency, path, title, period?, readings?}[] by date, summaries: {currency, count, first, last, min, max, change, days, perDay, perMonth}[] (one per currency; plain numbers have currency null), skipped: {notNumeric, undated, items: {path, title, reason}[]}}; --by keeps the last reading in each period", `${roll} by`, Infinity),
  label: read("<record>", "{path, title, data, version, size, text} or with --svg {..., svg}", `${roll} svg`, 1),
  key: { ...write("[new]", "{path, keys: {recipient, name}[]} or with new {recipient, path, name, created}", "name", 1), effect: "read; new writes a secret key to your GitRoll settings folder, never into a repository (not offered over MCP)" },
  recipients: { ...write("[add|remove <recipient>]", "{recipients: {recipient, label}[]}, plus added or removed", `${roll} name`, 2), effect: "read; add and remove change .gitroll/config.yaml and commit it" },
  seal: write("<file>", "{path, sealed, notices, history, commit}; history lists commits that still hold it in plain", `${roll} lines field`, 1),
  unseal: write("<file>", "{path, unsealed, notices, commit}", `${roll} lines field yes`, 1),
  "agents-md": { ...read("", "{path, text, written, committed, exists}", `${roll} write`, 0), effect: "read; --write writes .gitroll/AGENTS.md and commits it" },
  verify: { ...read("", "{ok, allowedSigners, scope, requireSigned, summary, commits: {commit, date, author, subject, signed, status, signer, key, agent, agentCheck}[]}; exit 1 on a bad signature or an agent mismatch, or with --require-signed on any change not signed by a listed key", `${roll} since require-signed`, 0), effect: "read; Git checks each commit's signature against .gitroll/allowed_signers" },
  // Not an MCP tool: an agent shouldn't mint its own identity.
  "agent-key": { ...write("<name>", "{agent, principal, publicKey, keyPath, created, added, committed, allowedSigners}", roll, 1), effect: "local write; makes an SSH signing key in GitRoll's settings folder (never in the Roll) and commits its public key to .gitroll/allowed_signers", mcp: false },
};
export const ALIASES: Record<string, string> = { recover: "undelete", trash: "deleted", serve: "open", clone: "join", list: "rolls", use: "switch", search: "find", timeline: "recent", rm: "delete", project: "projects", mv: "move", ingest: "import", update: "upgrade" };
const globals = ["help", "json", "plain", "non-interactive", "version", "agent"];
/** Commands that change something only once confirmed: --yes in noninteractive mode, yes: true over MCP. */
export const CONFIRMED = ["delete", "remove", "unseal"];
export const ENTRY_FIELDS = ["id", "path", "title", "date", "dateFrom", "projects", "tags", "amount", "attachments", "links", "source", "meta", "body"];
const canonical = (name: string): string => Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
const requiredArgs = (syntax: string): number => syntax.match(/^(?:<[^>]+>\s*)+/)?.[0].match(/<[^>]+>/g)?.length ?? 0;

export function commandSchema(name?: string) {
  if (name !== undefined && !Object.hasOwn(COMMANDS, canonical(name))) throw new CliError("INVALID_ARGUMENT", `Unknown command: ${name}`);
  const selected = name === undefined ? Object.entries(COMMANDS).filter(([key]) => key !== "__complete") : [[canonical(name), COMMANDS[canonical(name)]]] as [string, Command][];
  return {
    schemaVersion: 1,
    globals: Object.fromEntries(globals.map((flag) => [flag, CLI_OPTIONS[flag as keyof typeof CLI_OPTIONS]])),
    commands: selected.map(([name, command]) => ({
      name,
      aliases: Object.keys(ALIASES).filter((key) => ALIASES[key] === name),
      arguments: command.args,
      minArguments: requiredArgs(command.args),
      ...(command.max !== undefined && Number.isFinite(command.max) ? { maxArguments: command.max } : {}),
      options: Object.fromEntries(command.flags.split(" ").filter(Boolean).map((flag) => [flag, CLI_OPTIONS[flag as keyof typeof CLI_OPTIONS]])),
      effect: command.effect,
      json: command.json !== false,
      output: command.output,
    })),
    entryFields: ENTRY_FIELDS,
    error: { stream: "stderr", shape: { error: { code: "string", message: "string" } }, exitCode: 1, codes: ["INVALID_ARGUMENT", "NOT_FOUND", "CONFLICT", "AUTH_REQUIRED", "INTERACTION_REQUIRED", "UNSUPPORTED_MODE", "USER_ERROR", "INTERNAL_ERROR"] },
  };
}

export function validateCommand(raw: string, args: string[], values: Values): string {
  const name = canonical(raw);
  if (!Object.hasOwn(COMMANDS, name)) throw new CliError("INVALID_ARGUMENT", `“${raw}” isn't a GitRoll command. Run: gitroll help`);
  const command = COMMANDS[name];
  const allowed = new Set([...globals, ...command.flags.split(" ")]);
  for (const flag of Object.keys(values)) if (!allowed.has(flag)) throw new CliError("INVALID_ARGUMENT", `--${flag} isn't supported by ${name || "the default command"}. Run: gitroll schema ${name}`);
  if (command.max !== undefined && args.length > command.max) throw new CliError("INVALID_ARGUMENT", `Usage: gitroll ${name} ${command.args}`);
  const required = requiredArgs(command.args);
  if (name !== "import" && (args.length < required || args.slice(0, required).some((arg) => !arg.trim()))) throw new CliError("INVALID_ARGUMENT", `Usage: gitroll ${name} ${command.args}`);
  const invalid = (message: string): never => { throw new CliError("INVALID_ARGUMENT", message); };
  if (name === "shortcut" && values["dry-run"] && (!args.length || args[0].toLowerCase() === "off")) invalid("--dry-run applies to setting a shortcut: gitroll shortcut \"Ctrl+Alt+L\" --dry-run");
  if (name === "shortcut" && args.length && !args[0].trim()) invalid("Usage: gitroll shortcut [\"Ctrl+Alt+L\"|off]");
  if (name === "rolls" && args.length && args[0] !== "add") invalid("Usage: gitroll rolls [add [folder]]");
  if (name === "searches" && args.length && (args[0] !== "remove" || args.length !== 2)) invalid("Usage: gitroll searches [remove <name>]");
  if (name === "template" && args.length && (args[0] !== "set" || args.length !== 2 || values.set !== undefined)) invalid("Usage: gitroll template [--set <version>] or gitroll template set <version>");
  if (name === "backup" && args.length && values.owner) invalid("--owner applies only when creating a GitHub backup without a URL.");
  if (name === "share" && !args.length && values["read-only"]) invalid("--read-only requires a user to invite.");
  if (values.repo && values.roll) throw new CliError("INVALID_ARGUMENT", "Choose either -C/--repo or --roll, not both.");
  if (name === "edit" && values.text !== undefined && values.editor) invalid("Use either --text or --editor for the edit body.");
  for (const flag of ["limit", "offset"] as const) {
    if (values[flag] !== undefined && (!/^\d+$/.test(String(values[flag])) || !Number.isSafeInteger(Number(values[flag])))) throw new CliError("INVALID_ARGUMENT", `--${flag} must be a non-negative safe integer.`);
  }
  if (name === "import" && values.limit !== undefined && Number(values.limit) === 0) invalid("--limit must be positive for imports.");
  if (name === "import" && args[0] === "csv" && (args.length !== 3 || !args[1].trim() || !args[2].trim())) invalid("Usage: gitroll import csv <collection> <file.csv> [--dry-run]");
  if (name === "import" && args[0] !== "csv" && args.length > 2) invalid(`Usage: gitroll import ${COMMANDS.import.args}`);
  if (name === "records" && values.csv && !args.length) invalid("--csv takes a collection: gitroll records books --csv");
  if (name === "set" && (args.slice(1).some((arg) => !/^[A-Za-z_][\w-]*=/.test(arg)) || (args.length < 2 && !values.unset))) invalid("Usage: gitroll set <file> key=value [key=value...] [--unset key]");
  if ((name === "add" || name === "attach") && (values.field as string[] | undefined)?.some((f) => !/^[A-Za-z_][\w-]*=/.test(f))) invalid("--field takes key=value, e.g. --field rating=5");
  if (name === "reassemble" && !String(values.out ?? "").trim()) invalid("Usage: gitroll reassemble <file> --out <path>");
  if (name === "files" && values.open !== undefined && (args.length || values.unfiled)) invalid("Usage: gitroll files --open <file>");
  if ((values["non-interactive"] || values.json) && values.open !== undefined) throw new CliError("INTERACTION_REQUIRED", "--open hands a file to another app on this computer. Use gitroll reassemble <file> --out <path> to get a file in parts as one file.");
  if (values.fields !== undefined && name !== "records") {
    if (!values.json) throw new CliError("INVALID_ARGUMENT", "--fields requires --json.");
    if (!String(values.fields).split(",").every((field) => ENTRY_FIELDS.includes(field))) throw new CliError("INVALID_ARGUMENT", `--fields must be comma-separated names from: ${ENTRY_FIELDS.join(", ")}`);
  }
  if (name === "resolve" && [values.mine, values.theirs, values.editor].filter(Boolean).length !== 1) throw new CliError("INVALID_ARGUMENT", "Choose exactly one of --mine, --theirs, or --editor.");
  if (values.expect !== undefined && !/^[a-f0-9]{64}$/.test(String(values.expect))) throw new CliError("INVALID_ARGUMENT", "--expect must be the revision returned by show --json.");
  if (values.agent !== undefined && (!String(values.agent).trim() || String(values.agent).length > 100 || /[\x00-\x1f\x7f]/.test(String(values.agent)))) invalid("--agent must be a name of 1–100 characters on one line.");
  if (values["idempotency-key"] !== undefined && (!String(values["idempotency-key"]).trim() || String(values["idempotency-key"]).length > 200)) invalid("--idempotency-key must contain 1–200 characters and cannot be blank.");
  if (values.owner && ["new", "init"].includes(name) && !values.github) throw new CliError("INVALID_ARGUMENT", "--owner requires --github.");
  if (values.json && command.json === false) throw new CliError("UNSUPPORTED_MODE", `${name || "The default command"} doesn't support --json. Use a one-shot command from gitroll schema.`);
  if (values.json && name === "export" && values.format === "markdown" && !values.output) throw new CliError("INVALID_ARGUMENT", "Use --output for a Markdown export with --json, or omit --json.");
  if ((values["non-interactive"] || values.json) && (values.editor || (name === "log" && values.template) || ["", "setup", "open", "capture", "upgrade", "uninstall"].includes(name))) throw new CliError("INTERACTION_REQUIRED", "This operation launches an editor, capture window, browser/server or installer. Use an explicit one-shot command without interactive options.");
  if ((values["non-interactive"] || values.json) && !values.yes && (CONFIRMED.includes(name) || (name === "trust" && args.length))) throw new CliError("INTERACTION_REQUIRED", `${name} requires --yes in noninteractive mode.`);
  return name;
}

/** Recognize the output flag even if strict parsing fails, without mistaking
 * a string option's value or text after -- for a flag. */
export function requestsJson(argv: string[]): boolean {
  const options: Record<string, { type: string; short?: string }> = CLI_OPTIONS;
  let result = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--json" || arg.startsWith("--json=")) result = true;
    if (arg.startsWith("--")) {
      // A value is only a value if it isn't itself an option: `--amount --json`
      // is a missing value, which is how the parser reads it too. Skipping the
      // --json there is how a JSON caller got prose back.
      if (!arg.includes("=") && options[arg.slice(2)]?.type === "string" && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) i++;
    } else if (arg.startsWith("-")) {
      for (const [index, short] of [...arg.slice(1)].entries()) {
        const option = Object.values(options).find((value) => value.short === short);
        if (option?.type === "string") { if (index === arg.length - 2 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) i++; break; }
      }
    }
  }
  return result;
}

export function pageEntries(entries: LoadedEntry[], values: Values, defaultLimit?: number): unknown[] {
  const offset = Number(values.offset ?? 0);
  const limit = values.limit === undefined ? defaultLimit : Number(values.limit);
  const selected = entries.slice(offset, limit === undefined ? undefined : offset + limit);
  if (!values.fields) return selected;
  return selected.map((entry) => Object.fromEntries(String(values.fields).split(",").map((field) => [field, entry[field as keyof LoadedEntry] ?? null])));
}

export function errorCode(error: Error): string {
  if (error instanceof CliError) return error.code;
  if (error instanceof NotFoundError) return "NOT_FOUND";
  if (error instanceof ConflictError) return "CONFLICT";
  if (error instanceof AuthError) return "AUTH_REQUIRED";
  if ("code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) return "INVALID_ARGUMENT";
  return error instanceof UserError ? "USER_ERROR" : "INTERNAL_ERROR";
}
