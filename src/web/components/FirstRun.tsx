import { HardDrive, Tag, X } from "lucide-react";
import { useState } from "react";
import { DEFAULT_ROLL_NAME } from "../../core/layout.ts";
import type { SyncStatus } from "../store.ts";
import { Button } from "./ui/button.tsx";

/*
  The two things a brand-new Roll is missing, offered once and then gone.

  `gitroll log` makes a Roll on the spot rather than asking questions before a
  first entry. That is the right trade — but it leaves something called "My
  Roll" that exists on one computer, and neither fact announces itself. This
  says both, in the order they matter, and disappears as each is dealt with.

  It is not a wizard and not a nag: no steps, no progress bar, and dismissing it
  is remembered for this browser. Logging works perfectly well without either.
*/

const DISMISSED = "gitroll:first-run-dismissed";

export interface FirstRunProps {
  name: string;
  status: SyncStatus;
  entries: number;
  onName(): void;
  onBackUp(): void;
}

export function FirstRun({ name, status, entries, onName, onBackUp }: FirstRunProps) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === "1";
    } catch {
      // A private window, or storage turned off: show it, which is the default
      // this exists for. Nothing here is worth failing over.
      return false;
    }
  });

  const unnamed = name.trim() === DEFAULT_ROLL_NAME;
  const unbacked = !status.remote;
  // Nothing to say before there is anything to lose.
  if (hidden || !entries || (!unnamed && !unbacked)) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      // Then it comes back next time, which is the harmless direction to fail.
    }
  };

  return (
    <aside className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3" aria-labelledby="first-run-heading">
      <div className="flex items-start justify-between gap-2">
        <p id="first-run-heading" className="text-sm font-medium">
          Two things worth doing once
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide this"
          className="tap-target rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {unnamed && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            This Roll is still called “{DEFAULT_ROLL_NAME}”. A name makes it yours, here and in the terminal.
          </p>
          <Button variant="secondary" size="sm" onClick={onName}>
            <Tag aria-hidden="true" />
            Name it
          </Button>
        </div>
      )}

      {unbacked && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Everything you've written is on this computer and nowhere else. A folder on a drive is enough.
          </p>
          <Button variant="secondary" size="sm" onClick={onBackUp}>
            <HardDrive aria-hidden="true" />
            Back it up
          </Button>
        </div>
      )}
    </aside>
  );
}
