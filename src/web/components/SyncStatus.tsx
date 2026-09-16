import { AlertTriangle, Check, CloudOff, HardDrive, RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Store, SyncResult, SyncStage, SyncStatus as Status } from "../store.ts";
import { COPY, WEB_SAFETY } from "../copy.ts";
import { rollSafety, safetyBadge } from "../../core/safety.ts";
import { message, relativeTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

/*
  Backing up happens when someone asks for it, and not before.

  Saving already commits: the writing is on disk and in Git the moment it is
  written, and nothing about it is at risk while it waits. Uploading is the step
  that sends a private logbook somewhere else, and that is a decision, not
  housekeeping — the same decision `gitroll sync` asks for in the terminal, and
  the same answer in both places.

  So this is a status light that says how far behind the backup is, with the
  action next to it. It never uploads on its own.
*/

/** How often to ask where a running sync has got to. */
const PROGRESS_MS = 400;

const STAGE_TEXT: Record<SyncStage, string> = {
  checking: "Checking it's private…",
  downloading: "Downloading changes…",
  combining: "Combining changes…",
  uploading: "Uploading…",
};

/** A failure only a person can clear. Retrying by itself would just fail again. */
const NEEDS_A_PERSON = new Set(["public", "auth", "conflict", "unverified"]);

export interface UseSyncOptions {
  store: Store;
  enabled: boolean;
  onFinished(result: SyncResult): void;
  /** Called when a first backup has just been set up. */
  onBackedUp(): void;
}

export interface SyncState {
  /** The Roll, so the first backup can be set up from here. */
  store: Store;
  /** Called once a backup exists, so the app can refresh what it shows. */
  onBackedUp(): void;
  stage: SyncStage | null;
  running: boolean;
  lastResult: SyncResult | null;
  lastAt: number | null;
  /** The last failure is one only a person can clear, so trying again unchanged won't help. */
  blocked: boolean;
  sync(): void;
}

export function useSync({ store, enabled, onFinished, onBackedUp: onFinishedBackup }: UseSyncOptions): SyncState {
  const [stage, setStage] = useState<SyncStage | null>(null);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const blocked = !!lastResult && !lastResult.ok && NEEDS_A_PERSON.has(lastResult.code);

  const sync = useCallback(
    () => {
      if (inFlight.current || !enabled) return;
      inFlight.current = true;
      setRunning(true);
      setStage("checking");

      const progress = setInterval(() => {
        void store
          .syncProgress()
          .then((p) => setStage(p.stage))
          .catch(() => {});
      }, PROGRESS_MS);

      void store
        .sync()
        .then((result) => {
          setLastResult(result);
          setLastAt(Date.now());
          onFinished(result);
        })
        .catch(() => {
          // The connection watcher reports an unreachable app; nothing to add.
        })
        .finally(() => {
          clearInterval(progress);
          inFlight.current = false;
          setRunning(false);
          setStage(null);
        });
    },
    [store, enabled, onFinished],
  );

  return { store, onBackedUp: onFinishedBackup, stage, running, lastResult, lastAt, blocked, sync };
}

export interface SyncIndicatorProps {
  state: SyncState;
  status: Status;
  /** Opened from outside, so "Back it up" elsewhere lands on the form. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

export function SyncIndicator({ state, status, open: openProp, onOpenChange }: SyncIndicatorProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const backedUp = !!status.remote;
  const failed = state.lastResult && !state.lastResult.ok && state.lastResult.code !== "no-remote";

  const { icon: Icon, text, tone } = describe(state, status, backedUp, !!failed);
  const safe = rollSafety(status, WEB_SAFETY);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "tap-target inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            "hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <Icon className={cn("size-3.5", state.running && "animate-spin")} aria-hidden="true" />
          <span className="max-sm:sr-only">{text}</span>
          {status.ahead > 0 && !state.running && (
            <span className="rounded-full bg-muted px-1.5 py-px tabular-nums">{status.ahead}</span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{safe.headline}</p>
            <p className="text-xs text-muted-foreground">
              {state.running
                ? (state.stage ? STAGE_TEXT[state.stage] : COPY.syncing)
                : state.lastResult && !state.lastResult.ok
                  ? state.lastResult.message
                  : safe.detail}
            </p>
            {backedUp && !state.running && state.lastAt && (
              <p className="text-xs text-muted-foreground">Last backed up {relativeTime(new Date(state.lastAt).toISOString())}.</p>
            )}
          </div>

          {backedUp && status.remote && (
            <p className="text-xs text-muted-foreground">
              Goes to <span className="font-mono break-all">{status.remoteUrl ?? status.remote}</span>
              {/* The privacy check is for places on the internet. A folder on
                  this computer is already as private as the Roll itself. */}
              {isLocal(status.remoteUrl ?? status.remote)
                ? ", a folder on this computer."
                : ", which GitRoll checks is private before it uploads anything."}
            </p>
          )}

          {!backedUp && <FirstBackup store={state.store} onDone={state.onBackedUp} />}

          {backedUp && (
            <Button
              variant="secondary"
              size="sm"
              disabled={state.running}
              onClick={() => {
                state.sync();
                setOpen(false);
              }}
            >
              <RefreshCw className={cn(state.running && "animate-spin")} aria-hidden="true" />
              {state.running ? COPY.syncing : failed ? COPY.retry : "Back up now"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A path rather than somewhere on the internet. */
const isLocal = (url: string) => /^([/~.]|[A-Za-z]:[\\/]|file:)/.test(url);

/*
  The badge wording comes from core/safety.ts, so the browser, the terminal app
  and the CLI answer "is my entry safe?" with the same words. Only the two
  states that are about this session rather than the Roll — a sync in flight and
  a sync that just failed — are worded here.
*/
function describe(state: SyncState, status: Status, backedUp: boolean, failed: boolean) {
  if (state.running) return { icon: RefreshCw, text: state.stage ? STAGE_TEXT[state.stage] : COPY.syncing, tone: "muted" as const };
  if (failed && backedUp) return { icon: state.blocked ? AlertTriangle : CloudOff, text: COPY.syncFailed, tone: "error" as const };
  const safe = rollSafety(status, WEB_SAFETY);
  const icon = safe.level === "backed-up" ? Check : safe.level === "here-only" ? HardDrive : safe.level === "needs-a-hand" ? AlertTriangle : RefreshCw;
  return { icon, text: safetyBadge(safe, status), tone: safe.tone === "warn" ? ("error" as const) : ("muted" as const) };
}


/*
  The first backup, asked for in the one place that says there isn't one.

  A folder is offered first because it needs no account and no software: the
  point is that the Roll exists somewhere other than this computer. The server
  does the work — the browser cannot see a drive, and shouldn't be asked to.
*/
function FirstBackup({ store, onDone }: { store: Store; onDone(): void }) {
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  if (done) return <p className="text-xs text-muted-foreground">{done}</p>;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!destination.trim() || busy) return;
        setBusy(true);
        setError("");
        void store
          .backup(destination.trim())
          .then((result) => {
            setDone(
              result.sync.ok
                ? `Backed up to ${result.url}.${result.created ? " GitRoll made the repository there." : ""}`
                : result.sync.message,
            );
            onDone();
          })
          .catch((e) => setError(message(e)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        A folder to back up to — a drive, or a share. An address of an empty repository works too.
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="/Volumes/Backup/my-roll.git"
          aria-label="Where to back this Roll up"
          className="rounded-md border border-input bg-card px-2 py-1.5 font-mono text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" variant="secondary" size="sm" disabled={busy || !destination.trim()}>
        <HardDrive aria-hidden="true" />
        {busy ? "Backing up…" : "Back up here"}
      </Button>
    </form>
  );
}
