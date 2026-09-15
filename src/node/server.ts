// The GitRoll app for one Roll, on this computer only.
//
// - Binds to loopback only. Other devices can never connect.
// - Each run creates a random access key. The browser receives it once from the
//   link GitRoll opens, then keeps it in an HttpOnly cookie. Other programs and
//   other users on the same computer can't read or change the Roll without it.
// - Nothing private is cached by the browser.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { entryChangesFrom, entryInputFrom } from "../core/layout.ts";
import { NotFoundError, UserError, isActiveContent, mimeFor } from "../core/util.ts";
import { askRoll, shortId } from "./ai.ts";
import { safeRead } from "./fs-safe.ts";
import { GitError, HARD_MAX_ATTACHMENT_MB, assetDir } from "./repo.ts";
import type { FileInput, GitRoll, SyncResult, SyncStage } from "./repo.ts";
import type { AiSettings } from "./user-config.ts";

export const WEB_DIR = assetDir("index.html", "./web/", "../../dist/web/");
const MAX_BODY = HARD_MAX_ATTACHMENT_MB * 4 * 1024 * 1024; // base64 adds a third; allow a few large files
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
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
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
const NO_STORE = "no-store";

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
  /** Local AI settings for "Ask your Roll". */
  ai?: AiSettings | null;
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
  webDir: string;
  token: string;
  cookie: string;
  ai: AiSettings | null;
  sync: SyncState;
}

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
    ai: opts.ai ?? null,
    sync: { stage: null, running: null, startedAt: 0, last: null },
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
  return { server, url: `http://${shown}:${port}/?key=${ctx.token}` };
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
    return api(ctx, method, parts, req, res);
  }
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
  if (p.startsWith("/attachments/")) return sendAttachment(ctx.repo, decodeURIComponent(p.slice("/attachments/".length)), res);
  if (p === "/theme.css") return sendTheme(ctx.repo, res);
  return sendStatic(ctx.webDir, p, res);
}

async function api(ctx: Context, method: string, [resource, id, sub]: string[], req: http.IncomingMessage, res: http.ServerResponse) {
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
        ai: { enabled: !!ctx.ai && config.aiAllowed },
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
    case "POST ask": {
      const body = await readJson(req);
      const question = str(body.question).trim();
      if (!question) throw new UserError("Type a question first.");
      if (!ctx.ai) throw new UserError("Ask isn't set up. In a terminal, run: gitroll ai");
      if (!repo.config().aiAllowed) throw new UserError("Ask is turned off for this Roll.");
      const { answer, sources } = await askRoll(ctx.ai, repo.entries(), question, new Map());
      return sendJson(res, 200, { answer, sources: sources.map((e) => ({ id: e.id, short: shortId(e.id) })) });
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

function sendAttachment(repo: GitRoll, relPath: string, res: http.ServerResponse) {
  const file = repo.attachmentFile(relPath);
  if (!file) throw new HttpError(404, "File not found");
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

function sendTheme(repo: GitRoll, res: http.ServerResponse) {
  let css = "";
  try {
    css = safeRead(repo.root, "theme.css").toString("utf8");
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
