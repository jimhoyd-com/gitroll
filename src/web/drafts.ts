// Unsaved writing, kept where the browser can give it back.
//
// The terminal app has always kept a draft; the browser app kept none, so a
// reload, a stray Escape or a click on Log threw away whatever was in the box.
// Writing is the one thing GitRoll must never lose, so every composer — the new
// event and each event being edited — stores its draft under its own key, and
// only an explicit discard removes one.
//
// Drafts live in this browser's localStorage, never in the Roll: a draft is not
// an event, and nothing here is committed or synced. That also sets the limits
// honestly. Attached files are not kept (a File cannot be stored, and claiming
// otherwise would be a lie about somebody's receipt), so a draft records their
// names and says they need attaching again. Two tabs writing the same draft
// each keep their own text as they type and the last save wins; a tab reads a
// draft when its composer opens, not while someone is typing into it.

const PREFIX = "gitroll:draft";
/** Old drafts are worth keeping, but not forever: a month is longer than anyone leaves one. */
const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;

export interface StoredDraft {
  text: string;
  projects: string[];
  amount: string;
  when: string;
  extraTags: string[];
  /** Names of files that were attached when the draft was written. They are not kept. */
  attachments: string[];
  savedAt: number;
}

/** `entry` is an event's path, or null for the new-event composer. */
const keyFor = (roll: string, entry: string | null) => `${PREFIX}:${roll}:${entry ?? "new"}`;

/** localStorage throws in private windows and when site data is blocked. Nothing here is important enough to break a page over. */
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export function readDraft(roll: string, entry: string | null): StoredDraft | null {
  return safely(() => {
    const raw = localStorage.getItem(keyFor(roll, entry));
    if (!raw) return null;
    const draft = JSON.parse(raw) as StoredDraft;
    if (typeof draft?.text !== "string" || Date.now() - (draft.savedAt ?? 0) > MAX_AGE_MS) {
      localStorage.removeItem(keyFor(roll, entry));
      return null;
    }
    return draft;
  }, null);
}

export function writeDraft(roll: string, entry: string | null, draft: Omit<StoredDraft, "savedAt">): void {
  safely(() => localStorage.setItem(keyFor(roll, entry), JSON.stringify({ ...draft, savedAt: Date.now() })), undefined);
}

export function discardDraft(roll: string, entry: string | null): void {
  safely(() => localStorage.removeItem(keyFor(roll, entry)), undefined);
}

/** Every draft this browser is holding for one Roll, newest first. */
export function listDrafts(roll: string): { entry: string | null; draft: StoredDraft }[] {
  return safely(() => {
    const out: { entry: string | null; draft: StoredDraft }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(`${PREFIX}:${roll}:`)) continue;
      const entry = key.slice(`${PREFIX}:${roll}:`.length);
      const draft = readDraft(roll, entry === "new" ? null : entry);
      if (draft) out.push({ entry: entry === "new" ? null : entry, draft });
    }
    return out.sort((a, b) => b.draft.savedAt - a.draft.savedAt);
  }, []);
}
