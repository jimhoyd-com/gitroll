// Unsaved writing, kept on this computer and never inside a Roll.
//
// A draft is not an event. Nothing here is committed, synced, shared or logged:
// it lives beside GitRoll's own settings, readable only by the person who wrote
// it, and it is removed only when the writing it holds has been saved for real
// or the person has explicitly thrown it away.
//
// Quick Capture keeps one draft, with the Roll it is addressed to written into
// the draft itself, so the destination travels with the text instead of being
// looked up again at save time.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./user-config.ts";

const draftsDir = () => path.join(configDir(), "drafts");

function writeSecret(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * What Quick Capture is holding.
 *
 * `roll` is the Roll key the text is addressed to. It is part of the draft, so
 * changing Rolls while writing changes where this text is going and nothing
 * else — the words stay exactly as they are.
 *
 * `key` is minted once, when the draft starts, and reused for every attempt to
 * save it. A second press of the save keys, or a retry after a failure, carries
 * the same key and so can only ever produce the one event.
 */
export interface CaptureDraft {
  version: 1;
  text: string;
  roll: string;
  key: string;
  updated: string;
}

const captureFile = () => path.join(draftsDir(), "capture.json");

export const captureDraft = {
  load(): CaptureDraft | null {
    try {
      const draft = JSON.parse(fs.readFileSync(captureFile(), "utf8")) as CaptureDraft;
      if (typeof draft?.text !== "string" || typeof draft.roll !== "string" || typeof draft.key !== "string") return null;
      return draft;
    } catch {
      return null;
    }
  },
  /** Keeps the key of the draft already on disk, so retries stay the same request. */
  save(text: string, roll: string): CaptureDraft {
    const existing = captureDraft.load();
    const draft: CaptureDraft = {
      version: 1,
      text,
      roll,
      key: existing?.key ?? `capture-${randomUUID()}`,
      updated: new Date().toISOString(),
    };
    writeSecret(captureFile(), draft);
    return draft;
  },
  clear(): void {
    fs.rmSync(captureFile(), { force: true });
  },
};
