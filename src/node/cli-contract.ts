import { AuthError, ConflictError, NotFoundError, UserError } from "../core/util.ts";
import type { LoadedEntry } from "../core/layout.ts";
import { CLI_OPTIONS } from "./cli-options.ts";

export class CliError extends UserError {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type Values = Record<string, string | boolean | string[] | undefined>;
type Command = { args: string; flags: string; effect: string; output: string; max?: number; json?: false };
const read = (args: string, output: string, flags = "", max = 0): Command => ({ args, flags, effect: "read", output, max });
const write = (args: string, output: string, flags = "", max?: number): Command => ({ args, flags, effect: "local write", output, max });
const roll = "repo roll";
const paging = "limit offset fields";
export const COMMANDS: Record<string, Command> = {
  "": { args: "", flags: `${roll} port no-browser yes interactive`, effect: "interactive; may initialize a Roll", output: "terminal workspace", max: 0, json: false },
  help: read("[command|more|agent]", "{text} or agent guide or command schema", "", 1),
  schema: read("[command]", "{schemaVersion, globals, commands, error, entryFields}", "", 1),
  version: read("", "{version, method, ...installation details}"),
  menu: { ...read("", "terminal workspace", `${roll} port`), effect: "interactive writes", json: false },
  open: { ...read("[name]", "local web server", `${roll} port no-browser`, 1), effect: "starts server and optionally browser", json: false },
  setup: { ...write("", "interactive setup", "yes", 0), json: false },
  new: { ...write("<name...>", "{name, path}", "dir template github owner yes"), effect: "local write; --github creates and pushes to a private repository; remote --template downloads files" },
  init: { ...write("[name...]", "{name, path}", "dir template github owner yes"), effect: "local write; --github creates and pushes to a private repository; remote --template downloads files" },
  join: { ...write("<source> [name]", "{name, path}", "", 2), effect: "network read; local write" },
  rolls: { ...read("[add [folder]]", "Roll[] or {key, path, added, problems}", "", 2), effect: "read; add writes settings" },
  switch: write("<name>", "{defaultRoll}", "", 1),
  rename: write("<name...>", "{name}", roll),
  forget: write("<name>", "{forgotten}", "", 1),
  remove: write("<name>", "{deleted}", "delete-files yes", 1),
  backup: { ...write("[url]", "sync result {ok, code, message, ...}", `${roll} owner`, 1), effect: "network read/write; may create a private GitHub repository" },
  status: read("", "{name, path, events, problems, template, ...Git status}", roll),
  log: write("[text...] [files...]", "{entry, notices, replayed?}", `${roll} title editor template code tag file at amount idempotency-key`),
  find: { ...read("<query...>", "Entry[]; --all returns {roll, entries: Entry[]}[]", `${roll} save all include-archive ${paging}`, Infinity), effect: "read; --save writes settings" },
  today: read("", "Entry[]", `${roll} ${paging}`),
  recent: read("", "Entry[]", `${roll} ${paging}`),
  show: read("<file>", "Entry with revision (SHA-256 of file contents)", roll, 1),
  edit: write("<file> [files...]", "{entry, notices}", `${roll} text title editor tag file at amount expect`),
  delete: write("<file>", "{deleted: path}", `${roll} yes`, 1),
  history: read("<file>", "{commit, author, date, subject, patch}[]", roll, 1),
  restore: write("<file> [commit]", "{entry, from, unchanged}", roll, 2),
  related: read("<file>", "{links: string[], backlinks: string[], missing: string[]}", roll, 1),
  conflicts: read("", "Conflict[]", roll),
  resolve: write("<file>", "Entry", `${roll} mine theirs editor`, 1),
  templates: read("", "Template[]"),
  searches: { ...read("[remove <name>]", "{name: query} or {removed}", "", 2), effect: "read; remove writes settings" },
  completion: { ...read("<bash|zsh|fish>", "shell script", "", 1), json: false },
  __complete: { ...read("<kind>", "completion candidates", roll, 1), json: false },
  move: write("<file> <new-path>", "Entry", roll, 2),
  template: { ...read("[set <version>]", "TemplateStatus", `${roll} set`, 2), effect: "read; set writes a commit" },
  sync: { ...write("", "{ok, code, message, ...sync details}", roll, 0), effect: "network read/write; local write" },
  share: { ...write("[user]", "Collaborator[] or {invited, permission}", `${roll} read-only`, 1), effect: "network read; user argument grants access" },
  trust: write("[address]", "string[] or {trusted}", "yes", 1),
  untrust: write("<address>", "{untrusted}", "", 1),
  unshare: { ...write("<user>", "{removed}", roll, 1), effect: "revokes remote access" },
  check: read("", "{problems, sensitive}; exit 1 when problems exist", roll),
  doctor: { ...read("", "{checks: {level, message}[]}; exit 1 for failed checks", roll), effect: "local and network reads to check setup and backup visibility" },
  export: read("", "{roll, exported, events: Entry[]}, Markdown with --format markdown, or {output, format}", `${roll} format output`),
  import: { ...write("<github|ci|webhook> [source]", "{created, skipped} or --dry-run {create, skip}", `${roll} since until include only author label status branch tag limit dry-run`, 2), effect: "network read for GitHub/CI; writes events unless --dry-run" },
  storage: { ...read("", "{mode, timezone, limits, archive}", `${roll} mode timezone max-bytes max-entries archive-after compress`), effect: "read; any setting writes a commit" },
  archive: { ...write("<period>", "{period, archived, compressed, files}", `${roll} compress`, 1), effect: "local write; groups a filing period's files and marks it archived" },
  unarchive: { ...write("<period>", "{period, archived}", `${roll} auto`, 1), effect: "local write; reopens a period and restores plain Markdown" },
  migrate: { ...write("", "{mode, moved, skipped, items}", `${roll} to dry-run yes`, 0), effect: "local write; --dry-run previews without changing anything" },
  adopt: { ...write("", "{adopted, unmarked}", `${roll} dry-run yes`, 0), effect: "local write; gives hand-written entries permanent ids, changing nothing else" },
  usage: read("", "{segmentBytes, archivedBytes, attachmentBytes, segments, entries}", roll),
  upgrade: { ...read("", "how to upgrade", "", 0), json: false },
  uninstall: { ...read("", "how to remove GitRoll, and where the Rolls stay", "", 0), json: false },
};
export const ALIASES: Record<string, string> = { serve: "open", clone: "join", list: "rolls", use: "switch", add: "log", search: "find", timeline: "recent", rm: "delete", mv: "move", ingest: "import", update: "upgrade" };
const globals = ["help", "json", "plain", "non-interactive", "version"];
export const ENTRY_FIELDS = ["id", "path", "title", "date", "dateFrom", "tags", "tags", "amount", "attachments", "links", "source", "meta", "body"];
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
  if (name === "rolls" && args.length && args[0] !== "add") invalid("Usage: gitroll rolls [add [folder]]");
  if (name === "searches" && args.length && (args[0] !== "remove" || args.length !== 2)) invalid("Usage: gitroll searches [remove <name>]");
  if (name === "template" && args.length && (args[0] !== "set" || args.length !== 2 || values.set !== undefined)) invalid("Usage: gitroll template [--set <version>] or gitroll template set <version>");
  if (name === "backup" && args.length && values.owner) invalid("--owner applies only when creating a GitHub backup without a URL.");
  if (name === "share" && !args.length && values["read-only"]) invalid("--read-only requires a user to invite.");
  if (name === "ai") {
    const settingsFlags = ["model", "endpoint", "api-key-env", "allow-remote"];
    if ((!args.length || ["on", "off", "forget", "test"].includes(args[0])) && (args.length > 1 || settingsFlags.some((flag) => values[flag] !== undefined))) invalid("AI status, test, on, off and forget do not accept model settings or extra arguments.");
    if (args[0] === "custom" && args.length > 1) invalid("Use --model with ai custom.");
    if (args.length > 1 && values.model !== undefined) invalid("Supply the model positionally or with --model, not both.");
  }
  if (values.repo && values.roll) throw new CliError("INVALID_ARGUMENT", "Choose either -C/--repo or --roll, not both.");
  if (name === "edit" && values.text !== undefined && values.editor) invalid("Use either --text or --editor for the edit body.");
  for (const flag of ["limit", "offset"] as const) {
    if (values[flag] !== undefined && (!/^\d+$/.test(String(values[flag])) || !Number.isSafeInteger(Number(values[flag])))) throw new CliError("INVALID_ARGUMENT", `--${flag} must be a non-negative safe integer.`);
  }
  if (name === "import" && values.limit !== undefined && Number(values.limit) === 0) invalid("--limit must be positive for imports.");
  if (values.fields !== undefined) {
    if (!values.json) throw new CliError("INVALID_ARGUMENT", "--fields requires --json.");
    if (!String(values.fields).split(",").every((field) => ENTRY_FIELDS.includes(field))) throw new CliError("INVALID_ARGUMENT", `--fields must be comma-separated names from: ${ENTRY_FIELDS.join(", ")}`);
  }
  if (name === "resolve" && [values.mine, values.theirs, values.editor].filter(Boolean).length !== 1) throw new CliError("INVALID_ARGUMENT", "Choose exactly one of --mine, --theirs, or --editor.");
  if (values.expect !== undefined && !/^[a-f0-9]{64}$/.test(String(values.expect))) throw new CliError("INVALID_ARGUMENT", "--expect must be the revision returned by show --json.");
  if (values["idempotency-key"] !== undefined && (!String(values["idempotency-key"]).trim() || String(values["idempotency-key"]).length > 200)) invalid("--idempotency-key must contain 1–200 characters and cannot be blank.");
  if (values.owner && ["new", "init"].includes(name) && !values.github) throw new CliError("INVALID_ARGUMENT", "--owner requires --github.");
  if (values.json && command.json === false) throw new CliError("UNSUPPORTED_MODE", `${name || "The default command"} doesn't support --json. Use a one-shot command from gitroll schema.`);
  if (values.json && name === "export" && values.format === "markdown" && !values.output) throw new CliError("INVALID_ARGUMENT", "Use --output for a Markdown export with --json, or omit --json.");
  if ((values["non-interactive"] || values.json) && (values.editor || (name === "log" && values.template) || ["", "menu", "setup", "open"].includes(name))) throw new CliError("INTERACTION_REQUIRED", "This operation launches an interactive workspace, editor, browser/server or installer. Use an explicit one-shot command without interactive options.");
  if ((values["non-interactive"] || values.json) && !values.yes && (["delete", "remove"].includes(name) || (name === "trust" && args.length))) throw new CliError("INTERACTION_REQUIRED", `${name} requires --yes in noninteractive mode.`);
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
      if (!arg.includes("=") && options[arg.slice(2)]?.type === "string") i++;
    } else if (arg.startsWith("-")) {
      for (const [index, short] of [...arg.slice(1)].entries()) {
        const option = Object.values(options).find((value) => value.short === short);
        if (option?.type === "string") { if (index === arg.length - 2) i++; break; }
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
