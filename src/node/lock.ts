// One writer at a time, within one computer.
//
// Git protects a Roll from two *devices* changing it at once. It does nothing
// about two processes on this one — the app, a CLI command and an import
// running together — and a segment file is read-modify-write, so an unlucky
// interleaving silently drops an entry. Every write takes this lock first.
//
// The lock is a directory (created atomically on every filesystem GitRoll
// supports) holding the owner's pid and start time, kept outside the working
// tree so it is never committed. A lock whose process is gone, or which is
// older than the timeout, is broken rather than inherited: a crash must not
// wedge a Roll.

import fs from "node:fs";
import path from "node:path";
import { UserError } from "../core/util.ts";

const STALE_MS = 60_000;
const WAIT_MS = 10_000;

export interface LockInfo {
  pid: number;
  at: number;
  what: string;
}

const infoFile = (dir: string) => path.join(dir, "owner.json");

function readInfo(dir: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(infoFile(dir), "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Runs `fn` with the Roll's write lock held. Blocks briefly for another writer, then gives up with advice. */
export function withWriteLock<T>(gitDir: string, what: string, fn: () => T): T {
  const dir = path.join(gitDir, "gitroll-write.lock");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(infoFile(dir), JSON.stringify({ pid: process.pid, at: Date.now(), what } satisfies LockInfo));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const info = readInfo(dir);
      const stale = !info || Date.now() - info.at > STALE_MS || !alive(info.pid);
      if (stale) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new UserError(`Another GitRoll writer is busy here (${info.what}, pid ${info.pid}). Nothing was changed; try again in a moment.`);
      }
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
