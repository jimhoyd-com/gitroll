import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EntryInput } from "../core/layout.ts";
import { ConflictError } from "../core/util.ts";
import type { FileInput, GitRoll, SaveResult } from "./repo.ts";
import { CliError } from "./cli-contract.ts";

/** Retry identity travels with the event, including through moves and clones. */
export function saveIdempotent(roll: GitRoll, input: EntryInput, files: FileInput[], key: string, code: boolean): SaveResult & { replayed: boolean } {
  if (!key.trim() || key.length > 200) throw new CliError("INVALID_ARGUMENT", "--idempotency-key must contain 1–200 characters and cannot be blank.");
  // Do not hash the current commit: the first log itself advances HEAD. The
  // source snapshot recorded on the first attempt remains the source of truth.
  const { source, ...content } = input;
  const requestHash = createHash("sha256").update(JSON.stringify({ ...content, code, files: files.map((file) => ({ name: file.name, type: file.type, hash: createHash("sha256").update(file.data).digest("hex") })) })).digest("hex");
  const lockPath = path.resolve(roll.root, roll.git(["rev-parse", "--git-path", "gitroll-cli-log.lock"]).trim());
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConflictError(`Another keyed log may be running. Retry when it finishes. If a process crashed, inspect and remove its lock: ${lockPath}`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    const existing = roll.entries().filter((entry) => entry.source?.adapter === "gitroll-cli" && entry.source.id === key);
    if (existing.length > 1) throw new ConflictError("Multiple events have this idempotency key. Resolve the duplicate events before retrying.");
    if (existing.length) {
      const entry = existing[0];
      const stored = entry.meta.source as Record<string, unknown>;
      if (stored.request_hash !== requestHash) throw new ConflictError("This idempotency key was already used with different input. Use the original input or a new key.");
      // A failed commit can leave a file behind. Never call that a successful
      // retry, or create a second event to hide the incomplete first attempt.
      try { roll.git(["cat-file", "-e", `HEAD:${entry.path}`]); }
      catch { throw new ConflictError("The keyed event exists but is not committed at this path. Inspect Git status and finish or undo the earlier write before retrying."); }
      return { entry, notices: [], replayed: true };
    }
    const keyedSource = { ...source, adapter: "gitroll-cli", id: key, request_hash: requestHash };
    return { ...roll.save({ ...input, source: keyedSource }, files), replayed: false };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}
