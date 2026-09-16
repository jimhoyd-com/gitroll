// What you typed and didn't save yet.
//
// The terminal app keeps a draft between runs, and the browser didn't: a closed
// tab, a reload, a laptop that went to sleep, and the half-written entry was
// gone. Logging something is the one thing GitRoll exists to make easy, so the
// text survives the window it was typed into.
//
// It lives in this browser's storage, next to the Roll it belongs to — never in
// the Roll, which is for entries somebody decided to keep. Attachments are not
// kept: a File cannot be stored and a promise to have kept it would be a lie.

const KEY = "gitroll:draft";

export interface DraftValue {
  text: string;
  amount: string;
  when: string;
  time: string;
  extraTags: string[];
}

/** One Roll's draft, so two Rolls open in two tabs don't overwrite each other. */
const keyFor = (roll: string) => `${KEY}:${roll}`;

export function loadDraft(roll: string): DraftValue | null {
  try {
    const raw = localStorage.getItem(keyFor(roll));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftValue>;
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return null;
    return {
      text: parsed.text,
      amount: typeof parsed.amount === "string" ? parsed.amount : "",
      when: typeof parsed.when === "string" ? parsed.when : "",
      time: typeof parsed.time === "string" ? parsed.time : "",
      extraTags: Array.isArray(parsed.extraTags) ? parsed.extraTags.filter((t): t is string => typeof t === "string") : [],
    };
  } catch {
    // Storage off, private window, or something else's key: no draft, no fuss.
    return null;
  }
}

export function saveDraft(roll: string, value: DraftValue): void {
  try {
    if (!value.text.trim()) return clearDraft(roll);
    localStorage.setItem(keyFor(roll), JSON.stringify(value));
  } catch {
    // Out of quota or turned off. The entry is still on screen; nothing is lost
    // that wasn't already only on screen.
  }
}

export function clearDraft(roll: string): void {
  try {
    localStorage.removeItem(keyFor(roll));
  } catch {
    // Nothing to do, and nothing worth saying.
  }
}
