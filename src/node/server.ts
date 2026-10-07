// The GitRoll app for one Roll, on this computer only.
//
// - Binds to loopback only. Other devices can never connect.
// - Each run creates a random access key. The browser receives it once from the
//   link GitRoll opens, then keeps it in an HttpOnly cookie. Other programs and
//   other users on the same computer can't read or change the Roll without it.
// - Nothing private is cached by the browser.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { parseEntry } from "../core/entry.ts";
import { FIELD_NAME } from "../core/fields.ts";
import { entryChangesFrom, entryInputFrom } from "../core/layout.ts";
import { ConflictError, NotFoundError, UserError, isActiveContent, isRealTimestamp, mimeFor } from "../core/util.ts";
import { assignments } from "./cli-records.ts";
import { safeRead } from "./fs-safe.ts";
import { GitError, GitRoll, HARD_MAX_ATTACHMENT_MB, assetDir, isRepo } from "./repo.ts";
import type { FileInput, SyncResult, SyncStage } from "./repo.ts";
import { listFiles, searchRoll, wholeFile } from "./roll-files.ts";
import { calendarIcs } from "./cli-views.ts";
import { once } from "node:events";
import { SEALED_SUFFIX } from "../core/sealed.ts";
import { hasIdentity, maskEntry, openSealedFile } from "./sealing.ts";
import { loadUserConfig, removeSearch, renameSearch, saveSearch } from "./user-config.ts";

export const WEB_DIR = assetDir("index.html", "./web/", "../../dist/web/");
const MAX_BODY = HARD_MAX_ATTACHMENT_MB * 4 * 1024 * 1024; // base64 adds a third; allow a few large files
export const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
// Scripts stay strictly same-origin: no inline script, no third party, ever.
// That is the property that matters, and it is unchanged.
//
// Style is the one relaxation, and it is deliberate. The interface positions
// popovers, dialogs and menus by writing computed `style` attributes, and it
// locks background scrolling by injecting a <style> element; neither can be
// covered by a hash, and no nonce reaches them. Allowing inline style cannot
// load or execute anything, and every string the app renders from a Roll is
// sanitized before it reaches the DOM, so the worst an injection could do is
// restyle the page. Scripts, framing, objects and outbound connections stay
// locked down.
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
export const NO_STORE = "no-store";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ServeOptions {
  port: number;
  /** Loopback address to bind. Anything else is refused. */
  host?: string;
  /** Directory with the built web app. Defaults to the bundled build. */
  webDir?: string;
  /** Access key; random by default. */
  token?: string;
}

export interface Running {
  server: http.Server;
  /** Link that signs the browser in. Treat it like a password until GitRoll stops. */
  url: string;
}

/**
 * A sync in flight. Only one runs at a time: the app syncs by itself as well as
 * on request, and two git processes in one repository would fight. A second
 * caller joins the one already running instead of starting another.
 */
interface SyncState {
  stage: SyncStage | null;
  running: Promise<SyncResult> | null;
  startedAt: number;
  last: { at: number; result: SyncResult } | null;
}

interface Context {
  repo: GitRoll;
  host: string;
  webDir: string;
  token: string;
  cookie: string;
  sync: SyncState;
  /** The other Rolls this app opened from an All Rolls search; they close with it. */
  opened: Running[];
}

/**
 * Every Roll this process is serving, by folder, so following a search result
 * into a Roll that is already open reuses it rather than starting another.
 */
const serving = new Map<string, Running>();

export async function serve(repo: GitRoll, opts: ServeOptions): Promise<Running> {
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK.includes(host)) {
    throw new UserError("GitRoll only runs on this computer, so it can only listen on 127.0.0.1 or localhost.");
  }
  const webDir = path.resolve(opts.webDir ?? WEB_DIR) + path.sep;
  if (!fs.existsSync(path.join(webDir, "index.html"))) {
    throw new UserError("GitRoll's app files are missing. Reinstall GitRoll (or run `make build` from source).");
  }
  const ctx: Context = {
    repo,
    webDir,
    token: opts.token ?? randomBytes(32).toString("base64url"),
    cookie: "gitroll",
    sync: { stage: null, running: null, startedAt: 0, last: null },
    host,
    opened: [],
  };
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((err: Error) => {
      const status =
        err instanceof HttpError ? err.status : err instanceof NotFoundError ? 404 : err instanceof UserError ? 400 : 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) res.end();
      else sendJson(res, status, { error: status >= 500 ? (err instanceof GitError ? err.message : "Something went wrong. See the terminal for details.") : err.message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  ctx.cookie = `gitroll_${port}`; // cookies aren't separated by port; keep two running Rolls apart
  const shown = host === "::1" ? "[::1]" : host;
  const running = { server, url: `http://${shown}:${port}/?key=${ctx.token}` };
  const folder = realFolder(repo.root);
  if (!serving.has(folder)) serving.set(folder, running);
  server.on("close", () => {
    if (serving.get(folder) === running) serving.delete(folder);
    for (const other of ctx.opened) other.server.close();
  });
  return running;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function signedIn(ctx: Context, req: http.IncomingMessage): boolean {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ctx.cookie && sameSecret(value.join("="), ctx.token)) return true;
  }
  return false;
}

async function handle(ctx: Context, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://gitroll.local");
  // Refuse DNS rebinding: a website elsewhere can't pose as this computer.
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!LOOPBACK.includes(host)) throw new HttpError(403, "Forbidden");
  const method = req.method ?? "GET";
  const p = url.pathname;

  const key = url.searchParams.get("key");
  if (key !== null) {
    if (!sameSecret(key, ctx.token)) throw new HttpError(403, "This GitRoll link is out of date. Use the link shown when you started GitRoll.");
    res.writeHead(303, {
      ...SECURITY_HEADERS,
      Location: "/",
      "Cache-Control": NO_STORE,
      "Set-Cookie": `${ctx.cookie}=${ctx.token}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end();
    return;
  }

  const isPrivate = p.startsWith("/api/") || p.startsWith("/attachments/") || p === "/theme.css";
  if (isPrivate && !signedIn(ctx, req)) throw new HttpError(401, "Open GitRoll from the link shown when you started it.");

  if (p.startsWith("/api/")) {
    // Requiring JSON forces a CORS preflight, which blocks cross-site form posts.
    if (method !== "GET" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Expected application/json");
    }
    const parts = p.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
    return api(ctx, method, parts, url.searchParams, req, res);
  }
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
  if (p.startsWith("/attachments/")) {
    const rel = decodeURIComponent(p.slice("/attachments/".length));
    if (rel.endsWith(SEALED_SUFFIX)) return sendSealedAttachment(ctx.repo, rel, res);
    return sendAttachment(ctx.repo, rel, res);
  }
  if (p === "/theme.css") return sendTheme(ctx.repo, res);
  return sendStatic(ctx.webDir, p, res);
}

async function api(ctx: Context, method: string, [resource, id, sub]: string[], params: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) {
  const { repo } = ctx;
  const route = `${method} ${resource ?? ""}${id ? "/:id" : ""}${sub ? `/${sub}` : ""}`;
  switch (route) {
    case "GET state": {
      const { entries, problems } = repo.load();
      const config = repo.config();
      const template = repo.template();
      const info = {
        name: config.name,
        author: repo.author,
        location: repo.root,
        maxAttachmentBytes: repo.maxAttachmentBytes(),
        problems,
        template,
        warnings: template.code === "ok" ? [] : [template.message],
        sync: repo.status(),
        templates: repo.templates(),
        filters: config.quickFilters,
        // Whether this server can open sealed files (it has a key). Sealed text is never sent opened.
        canUnseal: hasIdentity(),
      };
      return sendJson(res, 200, { info, entries, projects: repo.projects() });
    }
    case "POST entries": {
      const body = await readJson(req);
      return sendJson(res, 201, repo.save(entryInputFrom(body), toFiles(body.files)));
    }
    case "PATCH entries/:id": {
      const body = await readJson(req);
      return sendJson(res, 200, repo.saveChanges(id, entryChangesFrom(body), toFiles(body.files)));
    }
    case "DELETE entries/:id":
      repo.deleteEntry(id);
      return sendJson(res, 200, { ok: true });
    case "GET entries/:id/history":
      return sendJson(res, 200, { history: repo.history(id) });
    case "POST entries/:id/restore": {
      const body = await readJson(req);
      return sendJson(res, 200, repo.restoreVersion(id, str(body.commit)));
    }
    // Deleted events, and the way back. Recovery that only exists in the
    // terminal is recovery most people never find.
    case "GET deleted":
      return sendJson(res, 200, {
        deleted: repo.deleted().map((d) => ({ path: d.entry.path, title: d.entry.title, date: d.entry.date, deletedAt: d.deletedAt, body: d.entry.body })),
      });
    case "POST deleted": {
      const body = await readJson(req);
      return sendJson(res, 200, { entry: repo.restoreDeleted(str(body.path)) });
    }
    // What the Notes, Records, Upcoming, Ledger, Inventory and Files pages are
    // made from. The views themselves are worked out in the browser from these,
    // by the same functions in src/core that the command line uses.
    //
    // Each note is read again here alongside the revision of exactly those
    // bytes — as `gitroll show --json` pairs them — so a field edited in the
    // records table can be refused when the file has changed since the page
    // read it, the way `gitroll set --expect` is.
    case "GET views": {
      const revisions: Record<string, string> = {};
      const notes = repo.load().notes.map((n) => {
        try {
          const bytes = safeRead(repo.root, n.path);
          const read = parseEntry(n.path, bytes.toString("utf8"));
          revisions[n.path] = createHash("sha256").update(bytes).digest("hex");
          return read;
        } catch {
          return n; // changed under us into something unreadable: shown as loaded, not editable
        }
      });
      return sendJson(res, 200, { notes, revisions, todos: repo.todos(), files: listFiles(repo) });
    }
    // Writing from those pages: each is the command line's own path.
    // `gitroll note`:
    case "POST notes": {
      const body = await readJson(req);
      return sendJson(res, 201, repo.saveNote({ title: str(body.title), text: str(body.text) }));
    }
    // `gitroll add <collection> <title> --field k=v`:
    case "POST records": {
      const body = await readJson(req);
      const fields = assignments(fieldRows(Array.isArray(body.fields) ? body.fields : []));
      return sendJson(res, 201, repo.saveRecord({ collection: collectionName(body.collection), title: str(body.title), text: str(body.text), fields }));
    }
    // `gitroll set <file> k=v --unset k --expect <revision>`, for a note only,
    // named by its exact path, and only with the revision it was read at.
    case "POST fields": {
      const body = await readJson(req);
      const at = str(body.path);
      const expect = str(body.expect);
      if (!expect) throw new HttpError(400, "Invalid request");
      if (!repo.notes().some((n) => n.path === at)) throw new HttpError(404, "That record isn't in this Roll any more.");
      const set = assignments(fieldRows(isObject(body.set) ? Object.entries(body.set).map(([key, value]) => ({ key, value })) : []));
      const unset = Array.isArray(body.unset) ? body.unset.map(str) : [];
      if (unset.some((k) => !FIELD_NAME.test(k))) throw new HttpError(400, "Invalid request");
      try {
        return sendJson(res, 200, repo.setFields(at, set, unset, { expect }));
      } catch (e) {
        if (e instanceof ConflictError) {
          throw new HttpError(409, "This record changed on disk since the page read it, so nothing was saved. The table now shows what the file says; make the change again if it's still needed.");
        }
        throw e;
      }
    }
    // `gitroll pin <file>` and `gitroll unpin <file>`, for an event or note
    // named by its exact path. One key is set or taken out of the front
    // matter where it is, so nothing else in the file can be overwritten.
    case "POST pins": {
      const body = await readJson(req);
      const at = str(body.path);
      if (!repo.documents().some((d) => d.path === at)) throw new HttpError(404, "That isn't in this Roll any more.");
      return sendJson(res, 200, repo.setPinned(at, body.pinned === true));
    }
    // `gitroll close <issue> --note "…"`: an event whose resolves: links to the
    // issue. Closing one that is already resolved writes nothing.
    case "POST issues": {
      const body = await readJson(req);
      const at = str(body.path);
      if (!repo.documents().some((d) => d.path === at)) throw new HttpError(404, "That issue isn't in this Roll any more.");
      const result = repo.closeIssue(at, { note: str(body.note) });
      return sendJson(res, result.changed ? 201 : 200, result);
    }
    // `gitroll todo "…"`, into .gitroll/notes/todo.md, with an optional 📅 date.
    case "POST todo": {
      const body = await readJson(req);
      const text = str(body.text).replace(/\s+/g, " ").trim();
      const due = str(body.due);
      if (!text) throw new HttpError(400, "A to-do needs some words, like: Call the plumber.");
      if (due && !(DAY.test(due) && isRealTimestamp(due))) throw new HttpError(400, "A due date is a day, like 2026-11-01.");
      return sendJson(res, 201, repo.addTodo(due ? `${text} 📅 ${due}` : text));
    }
    case "POST todos": {
      const body = await readJson(req);
      const line = Number(body.line);
      if (!Number.isInteger(line) || line < 1) throw new HttpError(400, "Invalid request");
      const { entry } = repo.markTodo(str(body.path), line, body.done === true);
      return sendJson(res, 200, { entry });
    }
    case "GET calendar.ics":
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="gitroll.ics"',
        "Cache-Control": NO_STORE,
      });
      res.end(calendarIcs(repo));
      return;
    // Saved searches live in your settings folder, where `gitroll find --save`
    // keeps them: they are yours on this computer, for every Roll, and nothing
    // is written into a Roll or committed.
    case "GET searches":
      return sendJson(res, 200, { searches: loadUserConfig().searches ?? {} });
    case "POST searches": {
      const body = await readJson(req);
      const name = searchName(body.name);
      const from = str(body.from);
      let saved: string;
      try {
        saved = from ? renameSearch(searchName(from), name) : saveSearch(name, searchText(body.query));
      } catch (e) {
        if (e instanceof ConflictError) throw new HttpError(409, e.message);
        throw e;
      }
      return sendJson(res, from ? 200 : 201, { name: saved, searches: loadUserConfig().searches ?? {} });
    }
    case "DELETE searches/:id":
      removeSearch(searchName(id));
      return sendJson(res, 200, { searches: loadUserConfig().searches ?? {} });
    // `gitroll find "…" --all`: the same search over every Roll on this
    // computer, this one first. Read-only; nothing in any Roll changes.
    case "GET rolls":
      return sendJson(res, 200, { rolls: searchEverywhere(ctx.repo, searchText(params.get("q"))) });
    // Following a result into another Roll opens that Roll's app, as `gitroll
    // open <name>` would, in this process and with its own access key.
    case "POST rolls/:id/open":
      return sendJson(res, 200, { url: await openRoll(ctx, id) });
    case "GET conflicts":
      return sendJson(res, 200, { conflicts: repo.conflicts() });
    case "POST entries/:id/resolve": {
      const body = await readJson(req);
      const keep = str(body.keep);
      const choice = keep === "mine" || keep === "theirs" ? keep : { text: str(body.text) };
      return sendJson(res, 200, { entry: repo.resolveConflict(id, choice) });
    }
    case "POST sync":
      return sendJson(res, 200, await runSync(ctx));
    case "GET sync":
      // Cheap enough for the app to poll every few hundred milliseconds while a
      // sync is running, so progress is real rather than an indeterminate spinner.
      return sendJson(res, 200, {
        running: ctx.sync.running !== null,
        stage: ctx.sync.stage,
        startedAt: ctx.sync.startedAt || null,
        last: ctx.sync.last,
        status: repo.status(),
      });
    default:
      throw new HttpError(404, "Not found");
  }
}

const MAX_QUERY = 1000;
/** Enough results from each Roll to see what's there; the Roll itself has the rest. */
const MAX_PER_ROLL = 50;

function searchName(v: unknown): string {
  const name = str(v).trim();
  if (!name || name.length > 64) throw new HttpError(400, "Give the search a short name, like open-incidents.");
  return name;
}

function searchText(v: unknown): string {
  const query = str(v).trim();
  if (!query) throw new HttpError(400, "Type something to search for first.");
  if (query.length > MAX_QUERY) throw new HttpError(400, "That search is too long.");
  return query;
}

/** A folder as the file system names it, so one Roll reached two ways is still one Roll. */
function realFolder(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export interface RollHits {
  /** The Roll's name in `gitroll rolls`, or null for this one when it isn't on the list. */
  key: string | null;
  name: string;
  /** The Roll this app is open on. */
  current: boolean;
  /** Why this Roll couldn't be searched, when it couldn't. */
  problem?: string;
  total: number;
  entries: ReturnType<typeof maskEntry>[];
}

function searchEverywhere(repo: GitRoll, query: string): RollHits[] {
  const here = realFolder(repo.root);
  const listed = Object.entries(loadUserConfig().rolls);
  const others = listed.filter(([, r]) => realFolder(r.path) !== here);
  const own = listed.find(([, r]) => realFolder(r.path) === here)?.[0] ?? null;
  const hits = (key: string | null, roll: GitRoll, current: boolean): RollHits => {
    const found = searchRoll(roll, query);
    return { key, name: roll.config().name, current, total: found.length, entries: found.slice(0, MAX_PER_ROLL).map((e) => maskEntry(e)) };
  };
  return [
    hits(own, repo, true),
    ...others.map(([key, r]): RollHits => {
      if (!isRepo(r.path)) return { key, name: key, current: false, problem: `Its folder isn't at ${r.path} any more.`, total: 0, entries: [] };
      try {
        return hits(key, new GitRoll(r.path), false);
      } catch (e) {
        return { key, name: key, current: false, problem: (e as Error).message, total: 0, entries: [] };
      }
    }),
  ];
}

/** The link that signs the browser in to another Roll's app, starting it if it isn't running. */
async function openRoll(ctx: Context, key: string): Promise<string> {
  const rolls = loadUserConfig().rolls;
  if (!Object.hasOwn(rolls, key)) throw new HttpError(404, "That Roll isn't on your list any more. See: gitroll rolls");
  const dir = rolls[key].path;
  if (!isRepo(dir)) throw new HttpError(404, `That Roll's folder isn't at ${dir} any more.`);
  const folder = realFolder(dir);
  if (folder === realFolder(ctx.repo.root)) return "/";
  const open = serving.get(folder);
  if (open) return open.url;
  const running = await serve(new GitRoll(dir), { port: 0, host: ctx.host, webDir: ctx.webDir });
  ctx.opened.push(running);
  return running.url;
}

/** Runs one sync at a time, recording where it has got to. */
function runSync(ctx: Context): Promise<SyncResult> {
  if (ctx.sync.running) return ctx.sync.running;
  ctx.sync.stage = "checking";
  ctx.sync.startedAt = Date.now();
  const run = ctx.repo
    .sync({ onStage: (stage) => (ctx.sync.stage = stage) })
    .then((result) => {
      ctx.sync.last = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      ctx.sync.running = null;
      ctx.sync.stage = null;
    });
  ctx.sync.running = run;
  return run;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "That upload is too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (isObject(v)) return v;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Invalid request");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FIELDS = 200;

/**
 * Fields as `key=value` lines, the way `--field` takes them: the value is YAML.
 * A field name is checked before it is joined to its value, so an `=` in a name
 * can never move into the value.
 */
function fieldRows(rows: unknown[]): string[] {
  if (rows.length > MAX_FIELDS) throw new HttpError(400, `A record can be written with up to ${MAX_FIELDS} fields at once.`);
  return rows.map((row) => {
    if (!isObject(row)) throw new HttpError(400, "Invalid request");
    const key = str(row.key).trim();
    const value = str(row.value);
    if (!FIELD_NAME.test(key)) {
      throw new HttpError(400, `"${key}" can't be a field name. A field name starts with a letter and has only letters, digits, - and _, like rating or due-date.`);
    }
    if (!value.trim()) throw new HttpError(400, `${key} has no value. Leave it out, or write "" for empty text.`);
    return `${key}=${value}`;
  });
}

/** A collection is a folder under notes/, named as `gitroll add` names one. Never a way out of it. */
function collectionName(v: unknown): string {
  const parts = str(v)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new HttpError(400, "Name the collection to add to, like books.");
  if (parts.some((s) => s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) throw new HttpError(400, "That isn't a collection's name.");
  return parts.join("/");
}

function toFiles(v: unknown): FileInput[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f): FileInput[] => {
    if (!isObject(f) || typeof f.data !== "string") return [];
    return [{ name: str(f.name), type: str(f.type) || undefined, data: Buffer.from(f.data, "base64") }];
  });
}

function contentType(ext: string): string {
  const type = mimeFor(ext);
  return /^text\/|javascript|json/.test(type) ? `${type}; charset=utf-8` : type;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE });
  res.end(JSON.stringify(data));
}

async function sendAttachment(repo: GitRoll, relPath: string, res: http.ServerResponse) {
  const file = repo.attachmentFile(relPath);
  if (!file) return sendParts(repo, relPath, res);
  const data = fs.readFileSync(file);
  const type = contentType(path.extname(file));
  const active = isActiveContent(type);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    // Uploaded HTML/SVG must never run as part of the app.
    "Content-Type": active ? "application/octet-stream" : type,
    "Content-Length": data.length,
    "Content-Security-Policy": "sandbox",
    "Cache-Control": NO_STORE,
    ...(active ? { "Content-Disposition": "attachment" } : {}),
  });
  res.end(data);
}

/**
 * A file kept in numbered parts (name.ext.001, .002, …), served as the one file
 * a link names: the parts are streamed in order, never read into memory whole.
 */
async function sendParts(repo: GitRoll, relPath: string, res: http.ServerResponse) {
  let whole;
  try {
    whole = wholeFile(repo, relPath);
  } catch (e) {
    throw new HttpError(404, (e as Error).message);
  }
  if (!whole) throw new HttpError(404, "File not found");
  const type = contentType(path.extname(whole.path));
  const active = isActiveContent(type);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": active ? "application/octet-stream" : type,
    "Content-Length": whole.size,
    "Content-Security-Policy": "sandbox",
    "Cache-Control": NO_STORE,
    ...(active ? { "Content-Disposition": "attachment" } : {}),
  });
  for (const part of whole.files) {
    for await (const chunk of fs.createReadStream(part)) {
      if (!res.write(chunk)) await once(res, "drain");
    }
  }
  res.end();
}

/**
 * A sealed file (x.pdf.age), opened only when this server's process has a key
 * that opens it, and served as what it is (x.pdf). Decrypted in memory for
 * this response; the plaintext is never written to disk. Without a key the
 * answer says it is sealed, rather than handing over ciphertext.
 */
async function sendSealedAttachment(repo: GitRoll, relPath: string, res: http.ServerResponse) {
  const file = repo.attachmentFile(relPath);
  if (!file) throw new HttpError(404, "File not found");
  const data = await openSealedFile(file);
  if (!data) throw new HttpError(403, "This file is sealed. Only someone with one of this Roll's keys can open it, and GitRoll on this computer has none that does.");
  const inner = relPath.slice(0, -SEALED_SUFFIX.length);
  const type = contentType(path.extname(inner));
  const active = isActiveContent(type);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": active ? "application/octet-stream" : type,
    "Content-Length": data.length,
    "Content-Security-Policy": "sandbox",
    "Cache-Control": NO_STORE,
    ...(active ? { "Content-Disposition": "attachment" } : {}),
  });
  res.end(data);
}

function sendTheme(repo: GitRoll, res: http.ServerResponse) {
  let css = "";
  try {
    css = safeRead(repo.root, ".gitroll/theme.css").toString("utf8");
  } catch {
    css = "";
  }
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/css; charset=utf-8", "Cache-Control": NO_STORE });
  res.end(css);
}

function sendStatic(webDir: string, p: string, res: http.ServerResponse) {
  const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
  const file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new HttpError(404, "Not found");
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType(path.extname(file)),
    "Content-Security-Policy": CSP,
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}
