// Opening sealed content in the browser, when the host can.
//
// This is an optional seam, like a store's views: the interface works the same
// without it, showing a placeholder for every sealed block, field and file. A
// host that holds an age key in the browser (GitRoll.com does, unwrapped in
// memory for the page's session) wraps the app in <UnsealerProvider>, and
// sealed parts are then shown opened, marked as sealed, or with an Unlock
// button when the key is still locked.
//
// What is opened stays on screen only. Nothing here writes, and plaintext is
// never handed to a store method: an edit keeps the sealed text as it was.

import { Lock, LockOpen } from "lucide-react";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import { fromUtf8 } from "../core/age/bytes.ts";
import { sealedBlocks, SEALED_SUFFIX } from "../core/sealed.ts";
import { extensionFor, isActiveContent, mimeFor } from "../core/util.ts";
import { message } from "./lib/format.ts";
import { renderMarkdown } from "./lib/markdown.ts";
import type { RenderContext } from "./lib/markdown.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { fieldText } from "./components/ViewParts.tsx";

/** Something the host provides that can open age-encrypted content in this browser. */
export interface Unsealer {
  /** True while a key is ready to use. */
  unlocked(): boolean;
  /** Called whenever `unlocked()` may have changed. Returns a function that stops listening. */
  subscribe(listener: () => void): () => void;
  /** Asks the host to unlock, e.g. by asking for the passphrase that protects the key. */
  unlock(): void;
  /**
   * The plaintext of an age file, armored or binary; null when no key is unlocked.
   * Rejects when the key doesn't open it or it is damaged.
   */
  open(sealed: string | Uint8Array): Promise<Uint8Array | null>;
}

const UnsealerContext = createContext<Unsealer | null>(null);

export function UnsealerProvider({ unsealer, children }: { unsealer: Unsealer | null; children: React.ReactNode }) {
  return <UnsealerContext.Provider value={unsealer}>{children}</UnsealerContext.Provider>;
}

const noSubscribe = () => () => {};

/** The host's unsealer and whether it is unlocked, or null when the host has none. */
export function useUnsealer(): { unsealer: Unsealer; unlocked: boolean } | null {
  const unsealer = useContext(UnsealerContext);
  const unlocked = useSyncExternalStore(unsealer ? unsealer.subscribe : noSubscribe, () => !!unsealer?.unlocked());
  return unsealer ? { unsealer, unlocked } : null;
}

type Opened<T> = { state: "locked" } | { state: "opening" } | { state: "open"; value: T } | { state: "error"; error: string };

/** Opens one sealed text while the key is unlocked; forgets it as soon as the key is locked again. */
function useOpenedText(armored: string): Opened<string> {
  const u = useUnsealer();
  const [result, setResult] = useState<Opened<string>>({ state: "locked" });
  useEffect(() => {
    if (!u?.unlocked) {
      setResult({ state: "locked" });
      return;
    }
    let live = true;
    setResult({ state: "opening" });
    u.unsealer.open(armored).then(
      (bytes) => live && setResult(bytes ? { state: "open", value: fromUtf8(bytes).replace(/\n$/, "") } : { state: "locked" }),
      (e) => live && setResult({ state: "error", error: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [u?.unsealer, u?.unlocked, armored]);
  return result;
}

function UnlockButton({ unsealer, label = "Unlock" }: { unsealer: Unsealer; label?: string }) {
  return (
    <Button type="button" size="sm" variant="secondary" onClick={() => unsealer.unlock()}>
      <Lock aria-hidden="true" />
      {label}
    </Button>
  );
}

// ── Blocks ─────────────────────────────────────────────────────────────────

type Segment = { kind: "text"; text: string } | { kind: "sealed"; armor: string };

function segments(body: string): Segment[] {
  const text = body.trim();
  const lines = text.split("\n");
  const out: Segment[] = [];
  let at = 0;
  for (const b of sealedBlocks(text)) {
    const before = lines.slice(at, b.start - 1).join("\n");
    if (before.trim()) out.push({ kind: "text", text: before });
    out.push({ kind: "sealed", armor: b.armor });
    at = b.end;
  }
  const rest = lines.slice(at).join("\n");
  if (rest.trim()) out.push({ kind: "text", text: rest });
  return out;
}

/**
 * An event's Markdown, with each sealed block opened when the host can open
 * it. Without an unsealer this is exactly the ordinary rendering.
 */
export function SealedMarkdown({ body, ctx, className }: { body: string; ctx: RenderContext; className?: string }) {
  const u = useUnsealer();
  const parts = u ? segments(body) : [];
  if (!u || !parts.some((p) => p.kind === "sealed")) {
    return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(body, ctx) }} />;
  }
  return (
    <div className={className}>
      {parts.map((p, i) =>
        p.kind === "text" ? <div key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text, ctx) }} /> : <SealedBlock key={i} armored={p.armor} ctx={ctx} />,
      )}
    </div>
  );
}

function SealedBlock({ armored, ctx }: { armored: string; ctx: RenderContext }) {
  const u = useUnsealer()!;
  const opened = useOpenedText(armored);
  if (opened.state === "open") {
    return (
      <section aria-label="Sealed content, opened in this browser" className="sealed-open my-3 rounded-lg border border-dashed border-border p-3">
        <Badge className="mb-2">
          <LockOpen aria-hidden="true" className="size-3" />
          Sealed
        </Badge>
        {/* Sanitized like any other Markdown: what was sealed is no more trusted than the rest. */}
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(opened.value, ctx) }} />
      </section>
    );
  }
  return (
    <div className="sealed my-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      <Lock aria-hidden="true" className="size-4" />
      <span className="flex-1">
        {opened.state === "error"
          ? `[sealed] This can't be opened with your key: ${opened.error}`
          : opened.state === "opening"
            ? "[sealed] Opening…"
            : "[sealed] Only someone with one of this Roll's keys can read this."}
      </span>
      {opened.state === "locked" && <UnlockButton unsealer={u.unsealer} />}
    </div>
  );
}

// ── Fields ─────────────────────────────────────────────────────────────────

/**
 * A sealed front matter value: opened when the host can, otherwise `fallback`
 * (what the page showed before) beside an Unlock button.
 */
export function SealedField({ armored, fallback }: { armored: string; fallback: React.ReactNode }) {
  const u = useUnsealer();
  if (!u) return <>{fallback}</>;
  return <OpenedField armored={armored} unsealer={u.unsealer} />;
}

function OpenedField({ armored, unsealer }: { armored: string; unsealer: Unsealer }) {
  const opened = useOpenedText(armored);
  if (opened.state === "open") {
    const shown = yamlScalarText(opened.value);
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>{shown}</span>
        <Badge>
          <LockOpen aria-hidden="true" className="size-3" />
          Sealed
        </Badge>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-muted-foreground">
      [sealed]
      {opened.state === "error" && <span>: {opened.error}</span>}
      {opened.state === "locked" && <UnlockButton unsealer={unsealer} />}
    </span>
  );
}

/**
 * A sealed field's plaintext is its value as YAML. Most are one scalar, which
 * reads the same as its text once any quotes are taken off; anything longer is
 * shown as the YAML it is. (A YAML parser would add a fifth to the bundle.)
 */
function yamlScalarText(yaml: string): string {
  const t = yaml.trim();
  if (/^".*"$/.test(t)) {
    try {
      return fieldText(JSON.parse(t));
    } catch {
      return t;
    }
  }
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// ── Files ──────────────────────────────────────────────────────────────────

/** True for a sealed file's path (x.pdf.age). */
export const isSealedFile = (path: string) => path.endsWith(SEALED_SUFFIX);

/**
 * A button that opens a sealed file (x.pdf.age) in this browser: it downloads
 * the ciphertext from `url`, opens it with the key, and shows the result from
 * a blob: URL. A type that can run script (HTML, SVG) is only ever downloaded,
 * because a blob: URL belongs to this page's origin. Returns null when the
 * host has no unsealer, so the caller keeps its ordinary link.
 */
export function SealedFileButton({ path, name, url }: { path: string; name: string; url: string }) {
  const u = useUnsealer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blob, setBlob] = useState<{ url: string; active: boolean; name: string } | null>(null);

  // A blob holds plaintext: let it go when the key is locked, or the button goes away.
  useEffect(() => {
    if (!u?.unlocked) setBlob(null);
  }, [u?.unlocked]);
  useEffect(() => () => void (blob && URL.revokeObjectURL(blob.url)), [blob]);

  if (!u) return null;
  const inner = (name.endsWith(SEALED_SUFFIX) ? name : path.split("/").pop() ?? name).slice(0, -SEALED_SUFFIX.length) || "file";

  const show = (b: { url: string; active: boolean; name: string }) => {
    const a = document.createElement("a");
    a.href = b.url;
    if (b.active) a.download = b.name;
    else {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    a.click();
  };

  const open = async () => {
    if (!u.unlocked) return u.unsealer.unlock();
    if (blob) return show(blob);
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.text()) || `The file couldn't be downloaded (${res.status}).`);
      const plain = await u.unsealer.open(new Uint8Array(await res.arrayBuffer()));
      if (!plain) return u.unsealer.unlock();
      const type = mimeFor(extensionFor(inner));
      const active = isActiveContent(type);
      const made = { url: URL.createObjectURL(new Blob([new Uint8Array(plain)], { type: active ? "application/octet-stream" : type })), active, name: inner };
      setBlob(made);
      show(made);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void open()}>
        {u.unlocked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
        {busy ? "Opening…" : u.unlocked ? `Open ${inner}` : "Unlock to open"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
