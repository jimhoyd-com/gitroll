// The Quick Capture window.
//
// Deliberately plain: no framework, no router, no store. This window has to be
// on screen and taking dictation before someone has finished pressing the keys
// that opened it, and everything it does — type, choose a Roll, save — is one
// small state machine. A few hundred lines of DOM beat a bundle that has to
// boot first.
//
// Everything it promises, it keeps:
//  - The destination Roll is visible at all times, never inferred, never
//    changed by GitRoll on its own.
//  - Changing the destination keeps every character of the draft.
//  - Escape hides the window and leaves the draft exactly as it is.
//  - A failure keeps the text and says what went wrong. Nothing here ever
//    closes as though a save succeeded.

interface CaptureRoll {
  key: string;
  name: string;
  path: string;
  missing: boolean;
  embedded: boolean;
  manualCommit: boolean;
}

interface State {
  rolls: CaptureRoll[];
  destination: string | null;
  defaultRoll: string | null;
  draft: { text: string; roll: string } | null;
  saveKeys: string;
  platform: string;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Quick Capture is missing #${id}`);
  return node as T;
};

const textarea = el<HTMLTextAreaElement>("text");
const destinationButton = el<HTMLButtonElement>("destination");
const message = el<HTMLElement>("message");
const keys = el<HTMLElement>("keys");
const picker = el<HTMLElement>("picker");
const filter = el<HTMLInputElement>("filter");
const list = el<HTMLUListElement>("rolls");

let rolls: CaptureRoll[] = [];
let destination: string | null = null;
let saveKeys = "Ctrl+Enter";
let saving = false;
let done = false;
let highlighted = 0;

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`api/${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || data === null) throw new Error(data?.error ?? `GitRoll couldn't be reached (${res.status}). Your note is still here.`);
  return data;
}

function say(text: string, kind: "" | "error" | "ok" = ""): void {
  message.textContent = text;
  message.className = kind;
}

const rollOf = (key: string | null): CaptureRoll | undefined => rolls.find((r) => r.key === key);

/**
 * The destination line. It says where this note is going, and — for a Roll that
 * lives inside a project repository — that everyone who can read that
 * repository can read this. That reminder belongs on every draft, not once at
 * setup: the exposure is a property of the note, not of the day it was agreed.
 */
function drawDestination(): void {
  const roll = rollOf(destination);
  const name = destinationButton.querySelector<HTMLElement>(".name");
  if (name) name.textContent = roll ? roll.name : destination ? `${destination} (not available)` : "Choose a Roll";
  for (const badge of destinationButton.querySelectorAll(".badge")) badge.remove();
  const add = (text: string, bad = false) => {
    const span = document.createElement("span");
    span.className = bad ? "badge bad" : "badge";
    span.textContent = text;
    destinationButton.append(span);
  };
  if (!roll) add("Unavailable", true);
  else if (roll.missing) add("Unavailable", true);
  else if (roll.embedded) add("Shared with repository");
  destinationButton.title = roll ? roll.path : "This Roll isn't available on this computer.";
}

// ── Drafts ─────────────────────────────────────────────────────────────────
//
// Saved as you type, a beat behind, and on every event that could lose the
// window. The destination is part of the draft, so the note and where it is
// going are never separated.

let pending: ReturnType<typeof setTimeout> | undefined;

function keepDraft(immediate = false): void {
  if (done || !destination) return;
  clearTimeout(pending);
  const write = () => void call("PUT", "draft", { text: textarea.value, roll: destination }).catch(() => {});
  if (immediate) write();
  else pending = setTimeout(write, 400);
}

// ── Saving ─────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  if (saving || done) return;
  if (!textarea.value.trim()) return say("There's nothing to save yet.");
  if (!destination) return say("This note has no destination yet. Choose a Roll.", "error");
  saving = true;
  say("Saving…");
  // The draft goes down first, with its retry key, so a crash between here and
  // the commit still leaves the words on disk.
  keepDraft(true);
  try {
    const result = await call<{ rollName: string; committed: boolean; notices: string[] }>("POST", "save", { text: textarea.value, roll: destination });
    done = true;
    say(result.committed ? `Saved to ${result.rollName}` : `Saved to ${result.rollName} — not committed yet`, "ok");
    textarea.readOnly = true;
    // The window is closed by GitRoll a moment from now, which is what hands
    // the keyboard back to whatever was in front before.
  } catch (e) {
    saving = false;
    // Every failure keeps the text. That is the whole point of this branch.
    say((e as Error).message, "error");
  }
}

// ── The Roll picker ────────────────────────────────────────────────────────

function matching(): CaptureRoll[] {
  const q = filter.value.trim().toLowerCase();
  if (!q) return rolls;
  return rolls.filter((r) => `${r.name} ${r.key} ${r.path}`.toLowerCase().includes(q));
}

function drawList(): void {
  const items = matching();
  highlighted = Math.min(highlighted, Math.max(items.length - 1, 0));
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.textContent = rolls.length ? "No Roll matches that." : "You don't have a Roll yet. Create one with: gitroll setup";
    empty.setAttribute("aria-disabled", "true");
    list.append(empty);
    return;
  }
  items.forEach((roll, index) => {
    const item = document.createElement("li");
    item.role = "option";
    item.id = `roll-${roll.key}`;
    item.setAttribute("aria-selected", String(index === highlighted));
    if (roll.missing) item.setAttribute("aria-disabled", "true");
    const dot = document.createElement("span");
    dot.className = roll.key === destination ? "dot" : "dot hidden";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = roll.name;
    item.append(dot, name);
    if (roll.missing) {
      const badge = document.createElement("span");
      badge.className = "badge bad";
      badge.textContent = "Unavailable";
      item.append(badge);
    } else if (roll.embedded) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Shared with repository";
      item.append(badge);
    }
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      choose(roll);
    });
    list.append(item);
  });
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function openPicker(): void {
  filter.value = "";
  highlighted = Math.max(rolls.findIndex((r) => r.key === destination), 0);
  picker.hidden = false;
  destinationButton.setAttribute("aria-expanded", "true");
  drawList();
  filter.focus();
}

function closePicker(): void {
  picker.hidden = true;
  destinationButton.setAttribute("aria-expanded", "false");
  textarea.focus();
}

/** Switching Rolls re-addresses the draft. It never touches a character of it. */
function choose(roll: CaptureRoll): void {
  if (roll.missing) {
    say(`"${roll.name}" isn't on this computer any more, so GitRoll won't save there. Pick another Roll.`, "error");
    return;
  }
  destination = roll.key;
  drawDestination();
  closePicker();
  say(roll.embedded ? `Going to ${roll.name}. Everyone who can read that repository can read this.` : `Going to ${roll.name}.`);
  keepDraft(true);
}

// ── Keys ───────────────────────────────────────────────────────────────────

const isSaveChord = (event: KeyboardEvent): boolean =>
  event.key === "Enter" && (navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey);

async function dismiss(): Promise<void> {
  // The draft is left alone on purpose: Escape is "not now", never "throw it away".
  keepDraft(true);
  await call("POST", "dismiss", {}).catch(() => {});
}

document.addEventListener("keydown", (event) => {
  if (!picker.hidden) {
    const items = matching();
    if (event.key === "Escape") {
      event.preventDefault();
      return closePicker();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      return drawList();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (items[highlighted]) choose(items[highlighted]);
      return;
    }
    return;
  }
  if (isSaveChord(event)) {
    event.preventDefault();
    void save();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void dismiss();
    return;
  }
  // One chord for the picker, and the same one everywhere.
  if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
    event.preventDefault();
    openPicker();
  }
});

destinationButton.addEventListener("click", openPicker);
filter.addEventListener("input", () => {
  highlighted = 0;
  drawList();
});
textarea.addEventListener("input", () => {
  if (message.className === "error") say("");
  keepDraft();
});
window.addEventListener("pagehide", () => keepDraft(true));
window.addEventListener("blur", () => keepDraft(true));

// ── Coming forward again ───────────────────────────────────────────────────
//
// A second press of the shortcut reaches the window that is already open
// instead of starting another. GitRoll's side raises it as far as the platform
// allows; this side puts the cursor back where the person left it.

let seq = 0;
function watchForActivation(): void {
  setInterval(() => {
    if (done) return;
    void call<{ seq: number; kind: string }>("GET", "signal")
      .then((signal) => {
        if (signal.seq === seq) return;
        seq = signal.seq;
        if (signal.kind !== "activate") return;
        window.focus();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        // `gitroll capture --roll <name>` re-addresses the draft while the
        // window is open. Adopt the destination; never touch what is typed.
        void call<State>("GET", "state")
          .then((state) => {
            rolls = state.rolls;
            if (!state.draft || state.draft.roll === destination) return;
            destination = state.draft.roll;
            drawDestination();
            say(`Going to ${rollOf(destination)?.name ?? destination}.`);
          })
          .catch(() => {});
      })
      .catch(() => {});
  }, 600);
}

// ── Start ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const state = await call<State>("GET", "state");
  rolls = state.rolls;
  destination = state.destination;
  saveKeys = state.saveKeys;
  keys.innerHTML = "";
  const hint = document.createElement("span");
  hint.append(kbd(saveKeys), document.createTextNode(" save · "), kbd("Esc"), document.createTextNode(" later · "), kbd(state.platform === "darwin" ? "⌘K" : "Ctrl+K"), document.createTextNode(" Roll"));
  keys.append(hint);
  if (state.draft) {
    textarea.value = state.draft.text;
    // The draft's own destination wins: it was chosen for this text.
    destination = state.draft.roll;
  }
  drawDestination();
  const roll = rollOf(destination);
  if (!roll) say(destination ? `"${destination}" isn't available, so nothing will be saved there. Choose another Roll.` : "Choose a Roll to save into.", "error");
  else if (roll.embedded) say("Shared with repository: everyone who can read it can read this.");
  else if (state.draft?.text) say("Picking up where you left off.");
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  watchForActivation();
  const seed = await call<{ seq: number }>("GET", "signal").catch(() => null);
  if (seed) seq = seed.seq;
}

function kbd(text: string): HTMLElement {
  const node = document.createElement("kbd");
  node.textContent = text;
  return node;
}

start().catch((e: Error) => {
  say(e.message || "Quick Capture couldn't start. Run: gitroll capture", "error");
});
