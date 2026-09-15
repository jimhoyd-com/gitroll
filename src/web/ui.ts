// GitRoll in the browser. Two things to do: log what happened, and find it again.
// Everything lives in the Roll's folder; this page only shows it.

import type { Attachment } from "../core/entry.ts";
import { DEFAULT_TYPE } from "../core/entry.ts";
import type { EntryChanges, LoadedEntry } from "../core/layout.ts";
import { SearchIndex, serialize, tokenize } from "../core/search.ts";
import type { Token } from "../core/search.ts";
import { normalizeData, typeFor, typeRegistry } from "../core/types.ts";
import type { EventType, FieldDef } from "../core/types.ts";
import { isoLocal, parseAmount } from "../core/util.ts";
import { ServerUnavailableError, SignedOutError } from "./store.ts";
import type { Store, SyncResult } from "./store.ts";

/** Every message the app shows, in one place so the wording stays consistent. */
const COPY = {
  saved: "Saved.",
  edited: "Changes saved. Earlier versions are in History.",
  deleted: "Deleted. It's still in History.",
  confirmDelete: "Delete this event? It won't show in your timeline, but it stays in History.",
  confirmDiscard: "Discard what you wrote?",
  badAmount: "That amount doesn't look right. Try 1850 or $1,850.",
  stopped: "GitRoll has stopped. Start it again from your terminal with: gitroll",
  signedOut: "For your privacy, open GitRoll from the link shown in your terminal.",
  empty: "Nothing logged yet.",
  noMatches: "Nothing found.",
  notBackedUp: "Not backed up yet",
  newProject: "Project name",
  askPlaceholder: "Ask a question, like: When was the AC last serviced?",
};

const POLL_MS = 10_000;

interface Finder {
  toggle(key: string, value: string): void;
  dates(after: string | null): void;
  clear(): void;
  query(): string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const view = $("#view");
const composerEl = $<HTMLDialogElement>("#composer");

let store: Store | null = null;
let index: SearchIndex<LoadedEntry> | null = null;
let indexVersion = "";
let registry = typeRegistry();
let reload: (() => void) | null = null;
let finder: Finder | null = null;
let current: LoadedEntry | null = null;
let lastSync: SyncResult | null = null;
let connection: "ok" | "stopped" | "signed-out" = "ok";

const S = (): Store => {
  if (!store) throw new Error(COPY.stopped);
  return store;
};

// ── Utilities ───────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const safeUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

function setHTML(el: HTMLElement | null, html: string): boolean {
  const node = el as (HTMLElement & { _html?: string }) | null;
  if (!node || node._html === html) return false;
  node.innerHTML = html;
  node._html = html;
  hydrate(node);
  return true;
}

let toastTimer = 0;
function toast(text: string, isError = false): void {
  const el = $("#toast");
  el.textContent = text;
  el.className = `show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = ""), isError ? 8000 : 3000);
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function fmtAmount(a: { value: number; currency: string }): string {
  try {
    return new Intl.NumberFormat([], { style: "currency", currency: a.currency }).format(a.value);
  } catch {
    return `${a.value} ${a.currency}`;
  }
}

function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const isImage = (a: { type: string }) => a.type.startsWith("image/") && !a.type.includes("svg") && !a.type.includes("heic");
const fileKind = (a: Attachment) => (isImage(a) ? "Photo" : a.type === "application/pdf" ? "PDF" : "File");
const projectName = (slug: string) => S().projects().find((p) => p.slug === slug)?.name ?? slug;
const qLink = (tokens: Token[]) => `#/?q=${encodeURIComponent(serialize(tokens))}`;

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderBody(text: string): string {
  if (!text.trim()) return "";
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${linkify(esc(para)).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function linkify(escaped: string): string {
  return escaped
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(
      /(^|[\s(>])#(\p{L}[\p{L}\p{N}_-]*)/gu,
      (_, pre: string, tag: string) =>
        `${pre}<a class="tag" href="${qLink([{ key: "tag", value: tag.toLowerCase() }])}" data-filter-key="tag" data-filter-value="${esc(tag.toLowerCase())}">#${tag}</a>`,
    );
}

function facetLink(key: string, value: string, label: string, cls = ""): string {
  return `<a class="${cls}" href="${qLink([{ key, value }])}" data-filter-key="${esc(key)}" data-filter-value="${esc(value)}">${label}</a>`;
}

function hydrate(root: ParentNode): void {
  if (!store) return;
  const byHash = new Map(store.entries().flatMap((e) => e.attachments.map((a) => [a.hash, a] as const)));
  for (const el of root.querySelectorAll<HTMLElement>("[data-att]")) {
    const a = byHash.get(el.dataset.att!);
    delete el.dataset.att;
    if (!a) continue;
    const url = store.attachmentUrl(a);
    if (el instanceof HTMLImageElement) {
      el.src = url;
      el.addEventListener("error", () => el.classList.add("broken"), { once: true });
    } else if (el instanceof HTMLAnchorElement) el.href = url;
  }
}

function idx(): SearchIndex<LoadedEntry> {
  const s = S();
  if (!index || indexVersion !== s.version()) {
    registry = typeRegistry(s.types());
    index = new SearchIndex(s.entries(), {
      projectNames: new Map(s.projects().map((p) => [p.slug, p.name])),
      typeLabels: new Map([...registry.values()].map((t) => [t.id, t.label])),
    });
    indexVersion = s.version();
  }
  return index;
}

/** Author names are only worth showing once more than one person logs in a Roll. */
const shared = () => new Set(S().entries().map((e) => e.author)).size > 1;

// ── Startup ─────────────────────────────────────────────────────────────────

export function showStopped(kind: "stopped" | "signed-out"): void {
  document.body.classList.remove("connected");
  view.innerHTML = `
    <section class="notice">
      <h1>GitRoll</h1>
      <p>${kind === "signed-out" ? esc(COPY.signedOut) : "GitRoll isn't running."}</p>
      ${kind === "stopped" ? `<p class="muted">Start it from your terminal:</p><pre class="cmd">gitroll</pre>` : ""}
    </section>`;
}

export interface AppOptions {
  /** Label for the sync button, e.g. "Refresh" where there's nothing to upload. */
  syncLabel?: string;
}

/** Starts the GitRoll interface on a Store: the local app, or GitRoll.com. */
export function startApp(s: Store, options: AppOptions = {}): void {
  if (window.top !== window.self) {
    document.body.textContent = "For your security, GitRoll can't be shown inside another page.";
    return;
  }
  wire();
  store = s;
  const label = $("#sync").childNodes[0];
  if (options.syncLabel && label) label.textContent = options.syncLabel;
  document.body.classList.add("connected");
  updateHeader();
  route();
}

function updateHeader(): void {
  const info = S().info();
  const sync = info.sync;
  $("#roll-name").textContent = info.name;
  document.title = `${info.name} · GitRoll`;
  const count = $("#sync-count");
  count.hidden = !sync.ahead;
  count.textContent = String(sync.ahead);
  $("#sync").title = !sync.remote
    ? `${COPY.notBackedUp}. Your events are saved on this computer.`
    : sync.ahead
      ? `${plural(sync.ahead, "change", "changes")} to sync`
      : "Everything is synced";
}

// ── Routing ─────────────────────────────────────────────────────────────────

function route(): void {
  if (!store) return;
  reload = null;
  finder = null;
  current = null;
  const hash = location.hash || "#/";
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) {
    if (a.dataset.nav === (hash.startsWith("#/projects") ? "projects" : "timeline")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  try {
    idx();
    let m: RegExpMatchArray | null;
    if ((m = hash.match(/^#\/?(?:\?q=(.*))?$/))) showTimeline(decodeURIComponent(m[1] ?? ""));
    else if (hash === "#/projects") showProjects();
    else if ((m = hash.match(/^#\/entry\/([^/?]+)$/))) showEntry(decodeURIComponent(m[1]));
    else location.replace("#/");
  } catch (err) {
    view.innerHTML = `<p class="banner error">${esc(message(err))}</p>`;
  }
}

function banners(): string {
  const info = S().info();
  const out: string[] = [];
  if (connection !== "ok") out.push(`<p class="banner error">${esc(connection === "signed-out" ? COPY.signedOut : COPY.stopped)}</p>`);
  for (const w of info.warnings) out.push(`<p class="banner">${esc(w)}</p>`);
  if (lastSync && !lastSync.ok && lastSync.code !== "no-remote") {
    out.push(`<p class="banner">${esc(lastSync.message)} <button class="link" data-action="sync">Try again</button></p>`);
  }
  if (info.problems.length) {
    out.push(`<details class="banner"><summary>${plural(info.problems.length, "file", "files")} in this Roll couldn't be read</summary>
      <ul>${info.problems.map((p) => `<li><code>${esc(p.path)}</code>: ${esc(p.error)}</li>`).join("")}</ul></details>`);
  }
  return out.join("");
}

// ── Find ────────────────────────────────────────────────────────────────────

function showTimeline(query: string): void {
  const all = tokenize(query);
  let filters: Token[] = all.filter((t) => t.key);
  const ai = S().info().ai.enabled;
  view.innerHTML = `
    <section class="find" role="search">
      <div class="searchbox">
        <input id="q" type="search" placeholder="Search" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-label="Search">
        ${ai ? `<button type="button" class="secondary" data-action="ask" title="${esc(COPY.askPlaceholder)}">Ask</button>` : ""}
      </div>
      <div class="chips" id="quick"></div>
    </section>
    <div id="answer"></div>
    <div id="banners"></div>
    <div id="summary"></div>
    <div id="list"></div>`;
  const input = $<HTMLInputElement>("#q");
  input.value = serialize(all.filter((t) => !t.key));

  const same = (t: Token, key: string, value: string) => t.key === key && t.value.toLowerCase() === value.toLowerCase();
  const full = () => [serialize(filters), input.value.trim()].filter(Boolean).join(" ");
  const apply = () => {
    const q = full();
    history.replaceState(null, "", q ? `#/?q=${encodeURIComponent(q)}` : "#/");
    reload?.();
  };

  finder = {
    toggle(key, value) {
      const i = filters.findIndex((f) => same(f, key, value));
      if (i >= 0) filters.splice(i, 1);
      else filters.push({ key, value });
      apply();
    },
    dates(after) {
      const was = filters.find((f) => f.key === "after")?.value;
      filters = filters.filter((f) => !["after", "before", "on"].includes(f.key!));
      if (after && after !== was) filters.push({ key: "after", value: after });
      apply();
    },
    clear() {
      filters = [];
      input.value = "";
      apply();
    },
    query: () => input.value.trim(),
  };

  reload = () => {
    const q = full();
    const results = idx().search(q);
    setHTML($("#banners"), banners());
    setHTML($("#quick"), quickChips(filters));
    setHTML($("#summary"), summary(results, !!q));
    setHTML(
      $("#list"),
      results.length || q
        ? timeline(results, `<p>${COPY.noMatches}</p>${q ? `<button class="link" data-action="clear-filters">Show everything</button>` : ""}`)
        : `<div class="empty"><p class="big">What happened?</p><p class="muted">${COPY.empty}</p><button class="primary" data-action="new">Log something</button></div>`,
    );
  };

  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(apply, 80);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && input.value) {
      input.value = "";
      apply();
    }
  });
  reload();
}

function quickChips(filters: Token[]): string {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const year = `${now.getFullYear()}-01-01`;
  const after = filters.find((t) => t.key === "after")?.value;
  const chip = (label: string, on: boolean, attrs: string) => `<button type="button" class="chip${on ? " on" : ""}" aria-pressed="${on}" ${attrs}>${label}</button>`;
  const fixed = [
    chip("This month", after === month, `data-date-after="${month}"`),
    chip("This year", after === year, `data-date-after="${year}"`),
    chip("With files", filters.some((t) => t.key === "has" && t.value === "attachment"), `data-filter-key="has" data-filter-value="attachment"`),
  ];
  const picked = filters
    .filter((t) => !(t.key === "has" && t.value === "attachment") && !(t.key === "after" && (t.value === month || t.value === year)))
    .map((t) => `<button type="button" class="chip on" data-filter-key="${esc(t.key!)}" data-filter-value="${esc(t.value)}" aria-label="Remove ${esc(filterLabel(t))}">${esc(filterLabel(t))} <span aria-hidden="true">×</span></button>`);
  return [...fixed, ...picked].join("");
}

function filterLabel(t: Token): string {
  switch (t.key) {
    case "project":
      return projectName(t.value);
    case "tag":
      return `#${t.value}`;
    case "type":
      return typeFor(registry, t.value).label;
    case "author":
      return t.value;
    case "after":
      return `Since ${t.value}`;
    case "before":
      return `Until ${t.value}`;
    case "on":
      return t.value;
    case "has":
      return `With ${t.value}`;
    default:
      return `${t.key}: ${t.value}`;
  }
}

function summary(results: LoadedEntry[], searching: boolean): string {
  if (!searching) return "";
  const totals = new Map<string, number>();
  for (const e of results) if (e.amount) totals.set(e.amount.currency, (totals.get(e.amount.currency) ?? 0) + e.amount.value);
  const parts = [plural(results.length, "event", "events")];
  for (const [currency, value] of totals) parts.push(`${fmtAmount({ value, currency })} total`);
  return `<p class="summary">${parts.map(esc).join(" · ")}</p>`;
}

function timeline(entries: LoadedEntry[], empty: string): string {
  if (!entries.length) return `<div class="empty">${empty}</div>`;
  const showAuthor = shared();
  let html = "";
  let last = "";
  for (const e of entries) {
    const d = new Date(e.occurred);
    if (d.toDateString() !== last) {
      html += `${last ? "</section>" : ""}<section class="day"><h2>${esc(dayLabel(d))}</h2>`;
      last = d.toDateString();
    }
    html += entryCard(e, showAuthor);
  }
  return `${html}</section>`;
}

function fieldRows(e: LoadedEntry, def: EventType): [string, string][] {
  const rows: [string, string][] = [];
  for (const f of def.fields) {
    const v = e.data[f.key];
    if (v != null && v !== "" && v !== false) rows.push([esc(f.label), fieldValue(f, v)]);
  }
  for (const [k, v] of Object.entries(e.data)) {
    if (def.fields.some((f) => f.key === k) || v == null || v === "") continue;
    rows.push([esc(k.replace(/_/g, " ")), esc(typeof v === "object" ? JSON.stringify(v) : String(v))]);
  }
  return rows;
}

function fieldValue(f: FieldDef, v: unknown): string {
  if (f.kind === "boolean") return v === true ? "Yes" : "No";
  if (f.kind === "date") {
    const d = new Date(`${String(v).slice(0, 10)}T12:00:00`);
    return esc(Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString([], { dateStyle: "medium" }));
  }
  if (f.kind === "url" && safeUrl(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)}</a>`;
  return esc(typeof v === "object" ? JSON.stringify(v) : String(v));
}

function labels(e: LoadedEntry, def: EventType): string {
  const parts: string[] = [];
  for (const p of e.projects) parts.push(facetLink("project", p, esc(projectName(p)), "project"));
  if (e.type !== DEFAULT_TYPE) parts.push(facetLink("type", e.type, esc(def.label), "kind"));
  if (e.amount) parts.push(`<span class="amount">${esc(fmtAmount(e.amount))}</span>`);
  return parts.length ? `<div class="labels">${parts.join("")}</div>` : "";
}

function footLine(e: LoadedEntry, showAuthor: boolean, withFiles = true): string {
  const bits: string[] = [];
  if (withFiles && e.attachments.length) bits.push(`<span>${plural(e.attachments.length, "file", "files")}</span>`);
  for (const t of e.tags) bits.push(facetLink("tag", t, `#${esc(t)}`, "tag"));
  if (showAuthor && e.author) bits.push(facetLink("author", e.author, esc(e.author), "author"));
  return bits.length ? `<div class="foot">${bits.join("")}</div>` : "";
}

function entryCard(e: LoadedEntry, showAuthor: boolean): string {
  const def = typeFor(registry, e.type);
  const images = e.attachments.filter(isImage);
  const rows = fieldRows(e, def).slice(0, 2);
  return `
    <article class="entry" data-id="${esc(e.id)}" tabindex="0">
      <time class="when" datetime="${esc(e.occurred)}">${fmtTime(e.occurred)}</time>
      <div class="content">
        ${labels(e, def)}
        <div class="body">${renderBody(e.body)}</div>
        ${rows.length ? `<div class="fields">${rows.map(([k, v]) => `<span><small>${k}</small> ${v}</span>`).join("")}</div>` : ""}
        ${images.length ? `<div class="thumbs">${images.slice(0, 4).map((a) => `<img data-att="${esc(a.hash)}" alt="${esc(a.name)}" loading="lazy">`).join("")}${images.length > 4 ? `<span class="more">+${images.length - 4}</span>` : ""}</div>` : ""}
        ${footLine(e, showAuthor)}
      </div>
    </article>`;
}

async function askRoll(): Promise<void> {
  const question = finder?.query() ?? "";
  const box = $("#answer");
  if (!question) {
    $<HTMLInputElement>("#q").placeholder = COPY.askPlaceholder;
    $<HTMLInputElement>("#q").focus();
    return;
  }
  box.innerHTML = `<div class="answer muted">Thinking…</div>`;
  try {
    const { answer, sources } = await S().ask(question);
    const byShort = new Map(sources.map((s) => [s.short, s.id]));
    const text = esc(answer).replace(/\[([0-9a-f]{8})\]/g, (_match, short: string) =>
      byShort.has(short) ? `<a href="#/entry/${encodeURIComponent(byShort.get(short)!)}" class="cite">view</a>` : "",
    );
    const cited = S().entries().filter((e) => sources.some((s) => s.id === e.id));
    box.innerHTML = `
      <div class="answer">
        <p>${text.replace(/\n/g, "<br>")}</p>
        ${cited.length ? `<p class="muted small">Based on ${plural(cited.length, "event", "events")} below. Answers can be wrong; check the events.</p>${timeline(cited, "")}` : `<p class="muted small">No events were cited. Answers can be wrong.</p>`}
        <button class="link" data-action="close-answer">Close</button>
      </div>`;
    hydrate(box);
  } catch (err) {
    box.innerHTML = `<p class="banner error">${esc(message(err))}</p>`;
  }
}

// ── Projects ────────────────────────────────────────────────────────────────

function showProjects(): void {
  view.innerHTML = `<div class="page-head"><h1>Projects</h1><button class="secondary" data-action="new-project">New project</button></div><div id="list"></div>`;
  reload = () => {
    const entries = S().entries();
    const known = S().projects();
    const orphans = [...new Set(entries.flatMap((e) => e.projects))].filter((slug) => !known.some((p) => p.slug === slug)).map((slug) => ({ slug, name: slug }));
    const rows = [...known, ...orphans].map((p) => {
      const mine = entries.filter((e) => e.projects.includes(p.slug));
      return { ...p, count: mine.length, last: mine[0]?.occurred };
    });
    setHTML(
      $("#list"),
      rows.length
        ? `<ul class="list">${rows.map((p) => `<li><a class="row" href="${qLink([{ key: "project", value: p.slug }])}"><strong>${esc(p.name)}</strong><span>${plural(p.count, "event", "events")}${p.last ? ` · ${esc(dayLabel(new Date(p.last)))}` : ""}</span></a></li>`).join("")}</ul>`
        : `<div class="empty"><p class="muted">Projects group related events, like House or Car.</p><button class="primary" data-action="new-project">New project</button></div>`,
    );
  };
  reload();
}

// ── Event ───────────────────────────────────────────────────────────────────

function showEntry(id: string): void {
  reload = () => {
    const e = S().entries().find((x) => x.id === id);
    if (!e) {
      current = null;
      view.innerHTML = `<button class="link back" data-action="back">← Back</button><div class="empty"><p class="muted">This event was deleted. It's still in History.</p></div>`;
      return;
    }
    if (current && JSON.stringify(current) === JSON.stringify(e)) return;
    current = e;
    const def = typeFor(registry, e.type);
    const rows = fieldRows(e, def);
    view.innerHTML = `
      <button class="link back" data-action="back">← Back</button>
      <article class="detail">
        <time datetime="${esc(e.occurred)}">${esc(new Date(e.occurred).toLocaleString([], { dateStyle: "full", timeStyle: "short" }))}</time>
        ${labels(e, def)}
        <div class="body large">${renderBody(e.body)}</div>
        ${rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
        ${e.attachments.length ? `<div class="attachments">${e.attachments.map(attachmentTile).join("")}</div>` : ""}
        ${footLine(e, shared(), false)}
        <div class="actions">
          <button class="secondary" data-action="edit">Edit</button>
          <button class="secondary" data-action="history">History</button>
          <button class="secondary danger" data-action="delete">Delete</button>
        </div>
        <details class="more-info">
          <summary>Details</summary>
          <dl class="facts">
            <dt>Logged by</dt><dd>${esc(e.author || "Unknown")}</dd>
            <dt>Logged on</dt><dd>${esc(new Date(e.created).toLocaleString())}</dd>
            ${e.source ? `<dt>Imported from</dt><dd>${esc(e.source.adapter)}</dd>` : ""}
            <dt>File</dt><dd><code>${esc(e.path)}</code></dd>
          </dl>
        </details>
        <section id="history" class="history"></section>
      </article>`;
    hydrate(view);
  };
  reload();
}

function attachmentTile(a: Attachment): string {
  if (isImage(a)) {
    return `<a class="att img" data-att="${esc(a.hash)}" target="_blank" rel="noopener noreferrer"><img data-att="${esc(a.hash)}" alt="${esc(a.name)}"></a>`;
  }
  const inline = a.type === "application/pdf" || /^(image|video|audio)\//.test(a.type) || a.type === "text/plain";
  return `<a class="att file" data-att="${esc(a.hash)}" ${inline ? `target="_blank" rel="noopener noreferrer"` : `download="${esc(a.name)}"`}>
    <span class="kind">${fileKind(a)}</span><span class="fname">${esc(a.name)}</span><small>${esc(fmtSize(a.size))}</small></a>`;
}

async function showHistory(e: LoadedEntry): Promise<void> {
  const box = $("#history");
  box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const items = await S().history(e.id);
    box.innerHTML = `<h2>History</h2><ol class="revs">${items
      .map((h, i) => {
        const first = i === items.length - 1;
        return `<li><div class="rev-head"><strong>${first ? "Logged" : "Edited"}</strong> ${esc(new Date(h.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · ${esc(h.author)}</div>
          ${first ? "" : `<pre class="diff">${diffLines(h.patch)}</pre>`}</li>`;
      })
      .join("")}</ol>`;
  } catch (err) {
    box.innerHTML = `<p class="banner error">${esc(message(err))}</p>`;
  }
}

function diffLines(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |\\ No newline|new file mode|deleted file mode|similarity index|rename (from|to) |@@)/.test(l))
    .filter((l) => /^[+-]/.test(l))
    .map((l) => `<span class="${l.startsWith("+") ? "add" : "del"}">${esc(l.slice(1)) || "&nbsp;"}</span>`)
    .join("\n");
}

// ── Log ─────────────────────────────────────────────────────────────────────

const composer = {
  editing: null as LoadedEntry | null,
  type: DEFAULT_TYPE,
  data: {} as Record<string, unknown>,
  files: [] as File[],
  removed: new Set<string>(),
  projects: new Set<string>(),
  initialWhen: "",
};
const previews = new Map<File, string>();

function singleProjectFilter(): string | undefined {
  const m = (location.hash || "").match(/^#\/?\?q=(.*)$/);
  if (!m) return undefined;
  const projects = tokenize(decodeURIComponent(m[1])).filter((t) => t.key === "project");
  return projects.length === 1 ? projects[0].value : undefined;
}

function openComposer(opts: { entry?: LoadedEntry; project?: string } = {}): void {
  const e = opts.entry ?? null;
  composer.editing = e;
  composer.type = e?.type ?? DEFAULT_TYPE;
  composer.data = { ...(e?.data ?? {}) };
  composer.files = [];
  composer.removed = new Set();
  composer.projects = new Set(e ? e.projects : opts.project ? [opts.project] : []);
  composer.initialWhen = e ? toLocalInput(e.occurred) : "";
  $("#c-title").textContent = e ? "Edit" : "What happened?";
  $<HTMLTextAreaElement>("#c-text").value = e?.body ?? "";
  $<HTMLInputElement>("#c-tags").value = e ? e.tags.join(", ") : "";
  $<HTMLInputElement>("#c-amount").value = e?.amount ? `${e.amount.value}${e.amount.currency !== "USD" ? ` ${e.amount.currency}` : ""}` : "";
  $<HTMLInputElement>("#c-when").value = composer.initialWhen;
  $<HTMLDetailsElement>("#c-more").open = !!e && (e.type !== DEFAULT_TYPE || e.projects.length > 0 || !!e.amount || e.tags.length > 0);
  renderTypeChips();
  renderFields();
  renderProjectChips();
  renderFiles();
  composerEl.showModal();
  $<HTMLTextAreaElement>("#c-text").focus();
}

function closeComposer(): void {
  for (const url of previews.values()) URL.revokeObjectURL(url);
  previews.clear();
  composerEl.close();
}

const composerDirty = () => !composer.editing && ($<HTMLTextAreaElement>("#c-text").value.trim() !== "" || composer.files.length > 0);

function renderTypeChips(): void {
  $("#c-types").innerHTML = [...registry.values()]
    .map((t) => `<button type="button" class="chip${composer.type === t.id ? " on" : ""}" data-type-pick="${esc(t.id)}" aria-pressed="${composer.type === t.id}">${esc(t.label)}</button>`)
    .join("");
}

function renderFields(): void {
  const def = typeFor(registry, composer.type);
  $("#c-fields").innerHTML = def.fields.map((f) => fieldInput(f, composer.data[f.key])).join("");
}

function fieldInput(f: FieldDef, value: unknown): string {
  const v = value == null ? "" : String(value);
  const attrs = `data-field="${esc(f.key)}"${f.required ? " required" : ""}`;
  const label = esc(f.label);
  switch (f.kind) {
    case "longtext":
      return `<label class="wide">${label}<textarea ${attrs} rows="2">${esc(v)}</textarea></label>`;
    case "select":
      return `<label>${label}<select ${attrs}><option value=""></option>${(f.options ?? []).map((o) => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
    case "boolean":
      return `<label class="check"><input type="checkbox" ${attrs}${value === true ? " checked" : ""}> ${label}</label>`;
    case "date":
      return `<label>${label}<input type="date" ${attrs} value="${esc(v.slice(0, 10))}"></label>`;
    case "number":
      return `<label>${label}<input type="number" step="any" ${attrs} value="${esc(v)}"></label>`;
    case "url":
      return `<label>${label}<input type="url" ${attrs} value="${esc(v)}" placeholder="https://"></label>`;
    default:
      return `<label>${label}<input ${attrs} value="${esc(v)}"></label>`;
  }
}

/** Prefills empty inputs from a type's declarative defaults. Never overwrites what the user typed. */
function applyTypeDefaults(def: EventType): void {
  const defaults = def.defaults;
  if (!defaults || composer.editing) return;
  const text = $<HTMLTextAreaElement>("#c-text");
  if (defaults.text && !text.value.trim()) text.value = defaults.text;
  const tags = $<HTMLInputElement>("#c-tags");
  if (defaults.tags?.length && !tags.value.trim()) tags.value = defaults.tags.join(", ");
  const amount = $<HTMLInputElement>("#c-amount");
  if (defaults.amount && !amount.value.trim()) amount.value = String(defaults.amount.value);
  for (const p of defaults.projects ?? []) composer.projects.add(p);
  for (const [k, v] of Object.entries(defaults.data ?? {})) if (composer.data[k] == null || composer.data[k] === "") composer.data[k] = v;
  renderProjectChips();
}

function captureFields(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>("#c-fields [data-field]")) {
    composer.data[el.dataset.field!] = el.type === "checkbox" ? (el.checked ? true : undefined) : el.value;
  }
}

function renderProjectChips(): void {
  const slugs = new Set([...S().projects().map((p) => p.slug), ...composer.projects]);
  $("#c-projects").innerHTML =
    [...slugs].map((s) => `<button type="button" class="chip${composer.projects.has(s) ? " on" : ""}" data-project-toggle="${esc(s)}" aria-pressed="${composer.projects.has(s)}">${esc(projectName(s))}</button>`).join("") +
    `<button type="button" class="chip add" data-action="composer-new-project">New project</button>`;
}

function addFiles(list: Iterable<File>): void {
  const max = S().info().maxAttachmentBytes;
  for (const f of list) {
    if (f.size > max) toast(`${f.name} is too large. Files can be up to ${Math.round(max / 1048576)} MB.`, true);
    else composer.files.push(f);
  }
  renderFiles();
}

function renderFiles(): void {
  const existing = (composer.editing?.attachments ?? []).map((a) => {
    const removed = composer.removed.has(a.hash);
    return `<div class="file${removed ? " removed" : ""}">${isImage(a) ? `<img data-att="${esc(a.hash)}" alt="">` : `<span class="kind">${fileKind(a)}</span>`}
      <span class="fname">${esc(a.name)}</span>
      <button type="button" class="link" data-remove-existing="${esc(a.hash)}">${removed ? "Keep" : "Remove"}</button></div>`;
  });
  const added = composer.files.map((f, i) => {
    let url = "";
    if (isImage(f)) {
      url = previews.get(f) ?? URL.createObjectURL(f);
      previews.set(f, url);
    }
    return `<div class="file">${url ? `<img src="${url}" alt="">` : `<span class="kind">File</span>`}
      <span class="fname">${esc(f.name || "Pasted file")}</span><small>${esc(fmtSize(f.size))}</small>
      <button type="button" class="link" data-remove-new="${i}">Remove</button></div>`;
  });
  const box = $("#c-files");
  box.innerHTML = [...existing, ...added].join("");
  hydrate(box);
}

async function submitComposer(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const button = $<HTMLButtonElement>("#c-submit");
  if (button.disabled) return;
  captureFields();
  const def = typeFor(registry, composer.type);
  const text = $<HTMLTextAreaElement>("#c-text").value;
  const tags = $<HTMLInputElement>("#c-tags").value.split(/[,\s]+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
  const amountRaw = $<HTMLInputElement>("#c-amount").value.trim();
  const amount = amountRaw ? parseAmount(amountRaw) : null;
  if (amountRaw && !amount) {
    $<HTMLDetailsElement>("#c-more").open = true;
    toast(COPY.badAmount, true);
    return;
  }
  // Keep this kind's fields plus any keys no known kind defines (written by other tools).
  const knownKeys = new Set([...registry.values()].flatMap((t) => t.fields.map((f) => f.key)));
  const data = normalizeData(def, Object.fromEntries(Object.entries(composer.data).filter(([k]) => def.fields.some((f) => f.key === k) || !knownKeys.has(k))));
  const when = $<HTMLInputElement>("#c-when").value;
  const editing = composer.editing;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    let notices: string[];
    if (editing) {
      const changes: EntryChanges = { text, type: composer.type, data, tags, projects: [...composer.projects], amount, removeAttachments: [...composer.removed] };
      if (when !== composer.initialWhen) changes.occurred = when ? isoLocal(new Date(when)) : "";
      ({ notices } = await S().updateEntry(editing.id, changes, composer.files, editing));
    } else {
      ({ notices } = await S().addEntry(
        { text, type: composer.type, data, tags, projects: [...composer.projects], amount: amount ?? undefined, occurred: when ? isoLocal(new Date(when)) : undefined },
        composer.files,
      ));
    }
    closeComposer();
    toast([editing ? COPY.edited : COPY.saved, ...notices].join(" "));
    updateHeader();
    route();
  } catch (err) {
    toast(message(err), true);
  } finally {
    button.disabled = false;
    button.textContent = "Save";
  }
}

// ── Sync, polling and events ────────────────────────────────────────────────

async function doSync(): Promise<void> {
  const button = $<HTMLButtonElement>("#sync");
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("busy");
  try {
    lastSync = await S().sync();
    toast(lastSync.message, !lastSync.ok);
  } catch (err) {
    toast(message(err), true);
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
    if (store) {
      updateHeader();
      reload?.();
    }
  }
}

async function poll(): Promise<void> {
  if (!store || document.visibilityState !== "visible" || composerEl.open) return;
  const before = store.version();
  const was = connection;
  try {
    await store.refresh();
    connection = "ok";
  } catch (err) {
    connection = err instanceof SignedOutError ? "signed-out" : err instanceof ServerUnavailableError ? "stopped" : connection;
  }
  if (store.version() !== before || was !== connection) {
    updateHeader();
    reload?.();
  }
}

function wire(): void {
  window.addEventListener("hashchange", route);
  $<HTMLFormElement>("#c-form").addEventListener("submit", (ev) => void submitComposer(ev as SubmitEvent));
  composerEl.addEventListener("cancel", (ev) => {
    if (composerDirty() && !confirm(COPY.confirmDiscard)) ev.preventDefault();
  });
  $("#c-file").addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    addFiles(input.files ?? []);
    input.value = "";
  });
  $("#c-text").addEventListener("paste", (ev) => {
    const files = [...((ev as ClipboardEvent).clipboardData?.files ?? [])];
    if (files.length) {
      ev.preventDefault();
      addFiles(files);
    }
  });
  composerEl.addEventListener("dragover", (ev) => ev.preventDefault());
  composerEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    addFiles(ev.dataTransfer?.files ?? []);
  });

  document.addEventListener("click", async (ev) => {
    const target = ev.target as HTMLElement;
    const el = target.closest<HTMLElement>("[data-action],[data-filter-key],[data-date-after],[data-type-pick],[data-project-toggle],[data-remove-existing],[data-remove-new],.entry");
    if (!el) return;
    const d = el.dataset;

    if (d.filterKey !== undefined) {
      if (finder) {
        ev.preventDefault();
        finder.toggle(d.filterKey, d.filterValue ?? "");
      }
      return;
    }
    if (d.dateAfter !== undefined) return finder?.dates(d.dateAfter);
    if (d.typePick) {
      captureFields();
      composer.type = d.typePick;
      applyTypeDefaults(typeFor(registry, d.typePick));
      renderTypeChips();
      renderFields();
      return;
    }
    if (d.projectToggle) {
      if (composer.projects.has(d.projectToggle)) composer.projects.delete(d.projectToggle);
      else composer.projects.add(d.projectToggle);
      renderProjectChips();
      return;
    }
    if (d.removeExisting) {
      if (composer.removed.has(d.removeExisting)) composer.removed.delete(d.removeExisting);
      else composer.removed.add(d.removeExisting);
      renderFiles();
      return;
    }
    if (d.removeNew !== undefined) {
      composer.files.splice(Number(d.removeNew), 1);
      renderFiles();
      return;
    }
    if (el.classList.contains("entry")) {
      if (!target.closest("a,button")) location.hash = `#/entry/${encodeURIComponent(d.id!)}`;
      return;
    }

    switch (d.action) {
      case "new":
        if (store) openComposer({ project: singleProjectFilter() });
        break;
      case "close":
        if (!composerDirty() || confirm(COPY.confirmDiscard)) closeComposer();
        break;
      case "new-project":
      case "composer-new-project": {
        const name = prompt(COPY.newProject)?.trim();
        if (!name) return;
        try {
          const project = await S().createProject(name);
          if (d.action === "composer-new-project") {
            composer.projects.add(project.slug);
            renderProjectChips();
          } else reload?.();
        } catch (err) {
          toast(message(err), true);
        }
        break;
      }
      case "clear-filters":
        finder?.clear();
        break;
      case "ask":
        void askRoll();
        break;
      case "close-answer":
        $("#answer").innerHTML = "";
        break;
      case "edit":
        if (current) openComposer({ entry: current });
        break;
      case "history":
        if (current) void showHistory(current);
        break;
      case "delete":
        if (current && confirm(COPY.confirmDelete)) {
          try {
            await S().deleteEntry(current.id, current);
            toast(COPY.deleted);
            updateHeader();
            location.hash = "#/";
          } catch (err) {
            toast(message(err), true);
          }
        }
        break;
      case "back":
        if (history.length > 1) history.back();
        else location.hash = "#/";
        break;
      case "sync":
        void doSync();
        break;
    }
  });

  document.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLElement;
    if (composerEl.open) {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        $<HTMLFormElement>("#c-form").requestSubmit();
      }
      return;
    }
    if (!store || ev.metaKey || ev.ctrlKey || ev.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (ev.key === "n") {
      ev.preventDefault();
      openComposer({ project: singleProjectFilter() });
    } else if (ev.key === "/") {
      ev.preventDefault();
      if (!finder) location.hash = "#/";
      setTimeout(() => $<HTMLInputElement>("#q")?.focus(), 0);
    } else if (ev.key === "Enter" && t.classList.contains("entry")) {
      location.hash = `#/entry/${encodeURIComponent(t.dataset.id!)}`;
    }
  });

  setInterval(() => void poll(), POLL_MS);
  document.addEventListener("visibilitychange", () => void poll());
}

