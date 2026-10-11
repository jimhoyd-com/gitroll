// Talking to the vault broker (broker.ts): one request per connection, with the
// session token. `unlock` starts the broker when none is running; every other
// request treats "no broker" as "locked".

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { ConflictError, NotFoundError, UserError } from "../../core/util.ts";
import { VaultError } from "../../core/vault/format.ts";
import type { VaultErrorCode } from "../../core/vault/format.ts";
import { MAX_MESSAGE, PROTOCOL_VERSION } from "./broker.ts";
import { ensureRuntimeDir, socketPath, tokenFile } from "./runtime.ts";

const locked = () => new VaultError("VAULT_LOCKED", "The vault is locked. Unlock it with: gitroll vault unlock <name>");

function readToken(): string | null {
  try {
    return fs.readFileSync(tokenFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function send(token: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(120_000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, token, ...body })}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_MESSAGE * 4) socket.destroy(new Error("reply too large"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const line = data.split("\n")[0];
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("no reply"));
      }
    });
  });
}

function asError(error: { code: string; message: string }): Error {
  if (error.code.startsWith("VAULT_")) return new VaultError(error.code as VaultErrorCode, error.message);
  if (error.code === "NOT_FOUND") return new NotFoundError(error.message);
  if (error.code === "CONFLICT") return new ConflictError(error.message);
  return new UserError(error.message);
}

async function attempt(body: Record<string, unknown>): Promise<unknown> {
  const token = readToken();
  if (!token) throw locked();
  let reply;
  try {
    reply = await send(token, body);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET") throw locked();
    throw new UserError("Couldn't reach the vault broker. Lock and unlock again: gitroll vault lock && gitroll vault unlock <name>");
  }
  if (!reply.ok) throw asError(reply.error ?? { code: "INTERNAL_ERROR", message: "The vault broker refused." });
  return reply.result;
}

export async function brokerRequest<T = unknown>(op: string, body: Record<string, unknown> = {}): Promise<T> {
  return (await attempt({ op, ...body })) as T;
}

/** True when a broker answers. */
export async function brokerRunning(): Promise<boolean> {
  try {
    await attempt({ op: "ping" });
    return true;
  } catch {
    return false;
  }
}

/** Starts the broker as a background process of this same program, and waits for it to answer. */
export async function startBroker(): Promise<void> {
  if (await brokerRunning()) return;
  ensureRuntimeDir();
  const entry = process.argv[1];
  // GITROLL_AGENT is a claim about who runs one command; the broker outlives it.
  const env = { ...process.env };
  delete env.GITROLL_AGENT;
  const child = spawn(process.execPath, [...process.execArgv, entry, "vault", "__broker"], { detached: true, stdio: "ignore", env, windowsHide: true });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (await brokerRunning()) return;
  }
  throw new UserError("The vault broker didn't start.");
}
