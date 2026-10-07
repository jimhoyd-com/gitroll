// A page for test/web-unseal.test.ts: one event with a sealed block, a sealed
// field and a sealed file, shown by the real EntryDetail. `?mode=` picks the
// host: "none" (no unsealer, as the local app is today), "locked" (a key that
// unlocks when asked) or "unlocked".
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { X25519Identity, decryptAny } from "../../src/core/age/format.ts";
import { parseEntry } from "../../src/core/entry.ts";
import { browserAgeCrypto } from "../../src/web/age-crypto.ts";
import { EntryDetail } from "../../src/web/components/EntryDetail.tsx";
import { UnsealerProvider } from "../../src/web/unseal.tsx";
import type { Unsealer } from "../../src/web/unseal.tsx";

const fixture = (await (await fetch("fixture.json")).json()) as { source: string; identity: string };
const mode = new URLSearchParams(location.search).get("mode") ?? "none";
const crypto = browserAgeCrypto();
const identity = X25519Identity.parse(fixture.identity);

let unlocked = mode === "unlocked";
const listeners = new Set<() => void>();
const unsealer: Unsealer = {
  unlocked: () => unlocked,
  subscribe(l) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  // The host's own prompt would go here; this one unlocks at once.
  unlock() {
    unlocked = true;
    for (const l of listeners) l();
  },
  open: async (sealed) => (unlocked ? decryptAny(sealed, [identity], crypto) : null),
};

const entry = parseEntry(".gitroll/events/2026-10-01-alarm.md", fixture.source);
const page = (
  <main id="main" className="mx-auto max-w-3xl p-4">
    <EntryDetail
      entry={entry}
      entries={[entry]}
      projectName={(s) => s}
      attachmentUrl={(a) => `files/${a.path.split("/").pop()}`}
      onFilter={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      loadHistory={async () => []}
      onRestore={async () => {}}
    />
  </main>
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>{mode === "none" ? page : <UnsealerProvider unsealer={unsealer}>{page}</UnsealerProvider>}</StrictMode>,
);
