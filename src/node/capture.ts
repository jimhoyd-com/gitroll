// Quick Capture: a small window that opens over whatever you were doing, takes
// one event, saves it, and gets out of the way.
//
// It is the same GitRoll underneath. The window talks to a loopback server with
// the same authentication, the same headers and the same content policy as the
// browser app, and it writes through `GitRoll.save` by way of the keyed writer
// the CLI already uses, so a capture is an ordinary event in an ordinary
// commit. There is no second event format and no second writer.
//
// Three rules shape the rest of this file:
//
//  - Writing is never lost. The draft is on disk before a save is attempted and
//    is removed only when an event is committed or the person discards it.
//  - A save is never claimed that did not happen. A written file with a failed
//    commit is reported as exactly that, and the draft stays.
//  - There is one window. A second `gitroll capture` activates the one already
//    open rather than starting a rival that holds a different draft.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { UserError } from "../core/util.ts";
import { captureDraft } from "./drafts.ts";
import type { CaptureDraft } from "./drafts.ts";
import { saveIdempotent } from "./cli-log.ts";
import { GitRoll, assetDir, isRepo } from "./repo.ts";
import { CSP, LOOPBACK, NO_STORE, SECURITY_HEADERS } from "./server.ts";
import { configDir, loadUserConfig, saveUserConfig } from "./user-config.ts";

export const CAPTURE_WEB_DIR = assetDir("capture.html", "./web/", "../../dist/web/");
/** Plenty for a note; small enough that nothing here is an upload path. */
const MAX_BODY = 512 * 1024;
const MAX_TEXT = 100_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A Roll as the picker needs to show it. */
export interface CaptureRoll {
  key: string;
  name: string;
  path: string;
  /** The folder is gone, or no longer holds a log. Such a Roll can be seen but not written to. */
  missing: boolean;
  /**
   * The Roll shares a repository with a project, so everyone who can read that
   * repository can read what is captured here. Shown on every draft addressed
   * to it, not once at setup.
   */
  embedded: boolean;
  /** This Roll writes the file but leaves committing to the person (`commit: manual`). */
  manualCommit: boolean;
}

/**
 * Whether a Roll lives inside somebody's project.
 *
 * Tracked files outside `.gitroll/` are the whole test, and it is deliberately
 * a question about the repository rather than about the machine: a Roll cloned
 * from a shared project is just as exposed as the original.
 */
function embeddedInProject(roll: GitRoll): boolean {
  try {
    const tracked = roll.git(["ls-files", "--", ":!.gitroll", ":!.gitignore", ":!README.md"]).trim();
    return tracked.length > 0;
  } catch {
    return false;
  }
}

function describeRoll(key: string, dir: string): CaptureRoll {
  if (!isRepo(dir)) return { key, name: key, path: dir, missing: true, embedded: false, manualCommit: false };
  try {
    const roll = new GitRoll(dir);
    const config = roll.config();
    return { key, name: config.name, path: roll.root, missing: false, embedded: embeddedInProject(roll), manualCommit: !config.autoCommit };
  } catch {
    return { key, name: key, path: dir, missing: true, embedded: false, manualCommit: false };
  }
}

/** Every Roll this person has, in the order the picker shows them. */
export function captureRolls(): CaptureRoll[] {
  const config = loadUserConfig();
  return Object.entries(config.rolls)
    .map(([key, r]) => describeRoll(key, r.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Where capture goes by default.
 *
 * This is a setting, not a memory of the last Roll used. Somebody who switched
 * to a work Roll to log one thing has not asked for tomorrow's half-formed
 * thought to land there too, and a capture window is exactly where that mistake
 * would be invisible.
 */
export function captureDestination(): string | null {
  const config = loadUserConfig();
  const chosen = config.captureRoll;
  if (chosen && config.rolls[chosen]) return chosen;
  return null;
}

export function setCaptureDestination(key: string): void {
  const config = loadUserConfig();
  if (!config.rolls[key]) throw new UserError(`There's no Roll called "${key}". See: gitroll rolls`);
  config.captureRoll = key;
  saveUserConfig(config);
}

// ── The window's server ────────────────────────────────────────────────────

interface Signal {
  /** Bumped every time something outside the window has to reach it. */
  seq: number;
  kind: "idle" | "activate" | "close";
}

interface Context {
  token: string;
  cookie: string;
  webDir: string;
  signal: Signal;
  /** When the window last said it was there. A window that stops answering is gone. */
  seenAt: number;
  /** Resolved when the window has finished: saved, dismissed or closed. */
  done: (outcome: CaptureOutcome) => void;
  finished: boolean;
}

export type CaptureOutcome = { kind: "saved"; path: string; roll: string; committed: boolean } | { kind: "dismissed" } | { kind: "closed" };

export interface CaptureService {
  url: string;
  port: number;
  token: string;
  /** Resolves once the window is done with. */
  finished: Promise<CaptureOutcome>;
  /** Ask a window that is already open to come forward. */
  activate(): void;
  /** True while a window has checked in recently. */
  hasWindow(): boolean;
  stop(): void;
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A window is "there" while it keeps checking in; it polls far more often than this. */
const WINDOW_TIMEOUT_MS = 6000;

export async function startCaptureService(opts: { port?: number; webDir?: string } = {}): Promise<CaptureService> {
  const webDir = path.resolve(opts.webDir ?? CAPTURE_WEB_DIR) + path.sep;
  if (!fs.existsSync(path.join(webDir, "capture.html"))) {
    throw new UserError("GitRoll's app files are missing. Reinstall GitRoll (or run `make build` from source).");
  }
  let settle: (outcome: CaptureOutcome) => void = () => {};
  const finished = new Promise<CaptureOutcome>((resolve) => (settle = resolve));
  const ctx: Context = {
    token: randomBytes(32).toString("base64url"),
    cookie: "gitroll_capture",
    webDir,
    signal: { seq: 0, kind: "idle" },
    seenAt: 0,
    finished: false,
    done: (outcome) => {
      if (ctx.finished) return;
      ctx.finished = true;
      settle(outcome);
    },
  };
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((err: Error) => {
      const status = err instanceof HttpError ? err.status : err instanceof UserError ? 400 : 500;
      if (status >= 500) console.error(err);
      if (res.headersSent) res.end();
      else sendJson(res, status, { error: status >= 500 ? "Something went wrong. See the terminal for details." : err.message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  ctx.cookie = `gitroll_capture_${port}`;
  return {
    url: `http://127.0.0.1:${port}/?key=${ctx.token}`,
    port,
    token: ctx.token,
    finished,
    activate: () => {
      ctx.signal = { seq: ctx.signal.seq + 1, kind: "activate" };
    },
    hasWindow: () => Date.now() - ctx.seenAt < WINDOW_TIMEOUT_MS,
    stop: () => {
      ctx.done({ kind: "closed" });
      server.close();
      server.closeAllConnections?.();
    },
  };
}

async function handle(ctx: Context, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://gitroll.local");
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!LOOPBACK.includes(host)) throw new HttpError(403, "Forbidden");
  const method = req.method ?? "GET";
  const p = url.pathname;

  const key = url.searchParams.get("key");
  if (key !== null) {
    if (!sameSecret(key, ctx.token)) throw new HttpError(403, "This capture window is out of date. Run: gitroll capture");
    res.writeHead(303, {
      ...SECURITY_HEADERS,
      Location: "/",
      "Cache-Control": NO_STORE,
      "Set-Cookie": `${ctx.cookie}=${ctx.token}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end();
    return;
  }

  // There is no unauthenticated way in. The page itself is static; everything
  // that can read or write a Roll needs the cookie the link sets.
  if (p.startsWith("/api/")) {
    if (!signedIn(ctx, req)) throw new HttpError(401, "Open the capture window from GitRoll: gitroll capture");
    if (method !== "GET" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Expected application/json");
    }
    return api(ctx, method, p.slice(5), req, res);
  }
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
  return sendStatic(ctx.webDir, p === "/" ? "capture.html" : p.replace(/^\/+/, ""), res);
}

function signedIn(ctx: Context, req: http.IncomingMessage): boolean {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ctx.cookie && sameSecret(value.join("="), ctx.token)) return true;
  }
  return false;
}

async function api(ctx: Context, method: string, route: string, req: http.IncomingMessage, res: http.ServerResponse) {
  // Only the window's own polling counts as the window being there. A second
  // `gitroll capture` asking it to come forward must not look like a window.
  if (["GET state", "GET signal", "PUT draft"].includes(`${method} ${route}`)) ctx.seenAt = Date.now();
  switch (`${method} ${route}`) {
    case "GET state":
      return sendJson(res, 200, state());
    // The window asks what it should be doing, several times a second. It is
    // how a second `gitroll capture` reaches the window that is already open.
    case "GET signal":
      return sendJson(res, 200, ctx.signal);
    case "PUT draft": {
      const body = await readJson(req);
      const draft = captureDraft.save(text(body.text), rollKeyOf(body.roll));
      return sendJson(res, 200, { draft: shown(draft) });
    }
    case "POST save": {
      const body = await readJson(req);
      const result = saveCapture(text(body.text), rollKeyOf(body.roll));
      ctx.done({ kind: "saved", path: result.path, roll: result.roll, committed: result.committed });
      return sendJson(res, 200, result);
    }
    // Escape. The draft is deliberately left exactly where it is.
    case "POST dismiss":
      ctx.done({ kind: "dismissed" });
      return sendJson(res, 200, { ok: true });
    // A second `gitroll capture` lands here. It never opens a rival window.
    case "POST activate":
      ctx.signal = { seq: ctx.signal.seq + 1, kind: "activate" };
      return sendJson(res, 200, { ok: true, seq: ctx.signal.seq });
    case "POST discard":
      captureDraft.clear();
      return sendJson(res, 200, { ok: true });
    default:
      throw new HttpError(404, "Not found");
  }
}

const shown = (draft: CaptureDraft) => ({ text: draft.text, roll: draft.roll, updated: draft.updated });

function state() {
  const rolls = captureRolls();
  const draft = captureDraft.load();
  const preferred = captureDestination();
  // A draft carries its own destination. The default only decides where a
  // *new* draft starts.
  const destination = draft?.roll ?? preferred ?? rolls[0]?.key ?? null;
  return {
    rolls,
    destination,
    defaultRoll: preferred,
    draft: draft ? shown(draft) : null,
    platform: process.platform,
    /** ⌘ on a Mac, Ctrl everywhere else. The window shows what it is told here. */
    saveKeys: process.platform === "darwin" ? "⌘Enter" : "Ctrl+Enter",
  };
}

export interface CaptureSaved {
  kind: "saved";
  path: string;
  title: string;
  roll: string;
  rollName: string;
  committed: boolean;
  replayed: boolean;
  notices: string[];
}

/**
 * Writes the capture, then says truthfully what happened.
 *
 * `saveIdempotent` is the CLI's keyed writer, and it is used here for the
 * property it already has: the key stored with the draft means a second press
 * of the save keys, or a retry after an error, finds the event that already
 * exists instead of writing another. It also refuses to call a file that was
 * written but never committed a successful retry, which is the failure this
 * window most needs not to paper over.
 */
export function saveCapture(body: string, rollKey: string): CaptureSaved {
  const trimmed = body.trim();
  if (!trimmed) throw new UserError("There's nothing to save yet.");
  if (trimmed.length > MAX_TEXT) throw new UserError("That's longer than a quick capture. Log it with: gitroll log --editor");
  const config = loadUserConfig();
  const known = config.rolls[rollKey];
  // A destination that has gone is never quietly replaced with another one.
  if (!known) throw new UserError(`The Roll "${rollKey}" isn't on your list any more. Choose another destination for this note, or restore it with: gitroll rolls add <folder>`);
  if (!isRepo(known.path)) throw new UserError(`"${rollKey}" isn't at ${known.path} any more, so nothing was saved. Choose another destination for this note, or fix the Roll with: gitroll rolls`);
  const roll = new GitRoll(known.path);
  // The draft on disk owns the retry key, so every attempt at this text is the
  // same request. Writing it first also means a crash between here and the
  // commit still leaves the words on disk.
  const draft = captureDraft.save(body, rollKey);
  const result = saveIdempotent(roll, { text: body }, [], draft.key, false);
  const committed = isCommitted(roll, result.entry.path);
  if (!committed && !roll.config().autoCommit) {
    // Manual-commit Rolls are doing what they were told, not failing.
    captureDraft.clear();
    return { kind: "saved", path: result.entry.path, title: result.entry.title, roll: rollKey, rollName: roll.config().name, committed: false, replayed: result.replayed, notices: [...result.notices, "Saved to the file, not committed: this Roll commits manually. Commit it with: gitroll save"] };
  }
  if (!committed) {
    // Written but not in Git. Saying "saved" here would be the lie that loses
    // the entry, so the draft stays and the person is told what to do.
    throw new UserError(`Your note was written to ${result.entry.path} but Git didn't commit it, so it isn't saved yet. Your text is still here. Finish it with: gitroll save`);
  }
  captureDraft.clear();
  return { kind: "saved", path: result.entry.path, title: result.entry.title, roll: rollKey, rollName: roll.config().name, committed: true, replayed: result.replayed, notices: result.notices };
}

function isCommitted(roll: GitRoll, rel: string): boolean {
  try {
    roll.git(["cat-file", "-e", `HEAD:${rel}`]);
    return true;
  } catch {
    return false;
  }
}

// ── One window, not several ────────────────────────────────────────────────

interface Singleton {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

const singletonFile = () => path.join(configDir(), "capture.json");

export function readSingleton(): Singleton | null {
  try {
    const data = JSON.parse(fs.readFileSync(singletonFile(), "utf8")) as Singleton;
    if (typeof data?.port !== "number" || typeof data.token !== "string" || typeof data.pid !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSingleton(data: Singleton): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${singletonFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, singletonFile());
}

export function clearSingleton(): void {
  const current = readSingleton();
  if (!current || current.pid === process.pid) fs.rmSync(singletonFile(), { force: true });
}

/**
 * Asks a capture window that is already running to come forward.
 *
 * Returns false when there isn't one, including when a stale file names a
 * process that has gone. Nothing here trusts the file on its own: the answer
 * has to come from a server that knows the token.
 */
export async function activateExisting(): Promise<boolean> {
  const current = readSingleton();
  if (!current) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${current.port}/api/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `gitroll_capture_${current.port}=${current.token}` },
      body: "{}",
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    // Nobody is listening, or it isn't ours. Either way there is no window.
    fs.rmSync(singletonFile(), { force: true });
    return false;
  }
}

// ── The window itself ──────────────────────────────────────────────────────

export interface WindowHandle {
  /** How the window was opened, so the caller can be honest about what it can do. */
  kind: "app" | "browser" | "none";
  close(): void;
}

const CHROMIUM_CANDIDATES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
};

function findAppBrowser(): string | null {
  if (process.env.GITROLL_CAPTURE_BROWSER) return process.env.GITROLL_CAPTURE_BROWSER;
  const candidates = CHROMIUM_CANDIDATES[process.platform] ?? CHROMIUM_CANDIDATES.linux;
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes("/")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir && fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
    }
  }
  return null;
}

/**
 * Opens the window.
 *
 * A Chromium-family browser in app mode gives a small chromeless window that
 * looks and behaves like one, and — because it runs in a profile of its own —
 * is a process GitRoll can close when the note is saved. Closing the window is
 * what hands the keyboard back to whatever the person was doing; no accessibility
 * permission is asked for and no other application is inspected.
 *
 * Without such a browser the note opens in the default browser instead. That
 * still works, and GitRoll says plainly that it cannot close that tab for you.
 */
export function openCaptureWindow(url: string, onExit: () => void = () => {}): WindowHandle {
  const browser = findAppBrowser();
  if (browser) {
    const profile = path.join(configDir(), "capture-window");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        "--window-size=520,340",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
      ],
      { stdio: "ignore", detached: false },
    );
    child.on("error", () => {});
    // Closing the window with its own controls is a way of saying "not now".
    child.on("exit", onExit);
    return {
      kind: "app",
      close: () => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      },
    };
  }
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return { kind: "browser", close: () => {} };
  } catch {
    return { kind: "none", close: () => {} };
  }
}

// ── Plumbing ───────────────────────────────────────────────────────────────

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "That's longer than a quick capture.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Invalid request");
}

const text = (v: unknown): string => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");

function rollKeyOf(v: unknown): string {
  const key = typeof v === "string" ? v.trim() : "";
  if (!key) throw new UserError("This note has no destination yet. Choose a Roll.");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(key)) throw new UserError("That isn't a Roll name GitRoll recognises.");
  return key;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": NO_STORE });
  res.end(JSON.stringify(data));
}

function sendStatic(webDir: string, rel: string, res: http.ServerResponse): void {
  const file = path.resolve(webDir, decodeURIComponent(rel));
  if (!file.startsWith(webDir) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new HttpError(404, "Not found");
  const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Security-Policy": CSP, "Cache-Control": NO_STORE });
  fs.createReadStream(file).pipe(res);
}

/** Where a helper writes what it is doing, for `gitroll capture --status`. */
export const helperStateFile = (): string => path.join(configDir(), "helper.json");
