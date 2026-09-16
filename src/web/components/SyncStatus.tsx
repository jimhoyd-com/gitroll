import { AlertTriangle, Check, CloudOff, HardDrive, RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Store, SyncResult, SyncStage, SyncStatus as Status } from "../store.ts";
import { COPY } from "../copy.ts";
import { plural, relativeTime } from "../lib/format.ts";
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
}

export interface SyncState {
  stage: SyncStage | null;
  running: boolean;
  lastResult: SyncResult | null;
  lastAt: number | null;
  /** The last failure is one only a person can clear, so trying again unchanged won't help. */
  blocked: boolean;
  sync(): void;
}

export function useSync({ store, enabled, onFinished }: UseSyncOptions): SyncState {
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

  return { stage, running, lastResult, lastAt, blocked, sync };
}

export interface SyncIndicatorProps {
  state: SyncState;
  status: Status;
}

export function SyncIndicator({ state, status }: SyncIndicatorProps) {
  const [open, setOpen] = useState(false);
  const backedUp = !!status.remote;
  const failed = state.lastResult && !state.lastResult.ok && state.lastResult.code !== "no-remote";

  const { icon: Icon, text, tone } = describe(state, status, backedUp, !!failed);

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
            <p className="text-sm font-medium">{backedUp ? "Backing up" : COPY.notBackedUp}</p>
            <p className="text-xs text-muted-foreground">
              {!backedUp
                ? COPY.notBackedUpHint
                : state.running
                  ? (state.stage ? STAGE_TEXT[state.stage] : COPY.syncing)
                  : state.lastResult && !state.lastResult.ok
                    ? state.lastResult.message
                    : state.lastAt
                      ? `Last backed up ${relativeTime(new Date(state.lastAt).toISOString())}.`
                      : COPY.backUpWhenReady}
            </p>
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

          {status.ahead > 0 && <p className="text-xs text-muted-foreground">{COPY.pendingChanges(status.ahead)}</p>}

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

function describe(state: SyncState, status: Status, backedUp: boolean, failed: boolean) {
  if (!backedUp) return { icon: HardDrive, text: COPY.notBackedUp, tone: "muted" as const };
  if (state.running) return { icon: RefreshCw, text: state.stage ? STAGE_TEXT[state.stage] : COPY.syncing, tone: "muted" as const };
  if (failed) return { icon: state.blocked ? AlertTriangle : CloudOff, text: COPY.syncFailed, tone: "error" as const };
  if (status.ahead > 0) return { icon: RefreshCw, text: plural(status.ahead, "change", "changes"), tone: "muted" as const };
  return { icon: Check, text: COPY.syncedJustNow, tone: "muted" as const };
}
