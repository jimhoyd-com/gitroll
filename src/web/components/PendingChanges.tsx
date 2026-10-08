import { AlertTriangle, CloudOff, Download, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { OutboxStore, PendingChange } from "../store.ts";
import { message, relativeTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { useAsk } from "./ui/ask.tsx";
import { useToast } from "./ui/toast.tsx";

/*
  Writing kept on this device until it reaches the Roll.

  A store that offers an outbox (GitRoll.com with "keep on this device") lets
  people save while offline. Those saves are not in the Roll yet, and that is
  the one thing this must never blur: the light says how many are only here,
  which are being sent, and which need a person. Nothing is thrown away except
  by the person, after they have had the chance to download it.
*/

const STATE_TEXT: Record<PendingChange["state"], string> = {
  "saved-locally": "On this device",
  syncing: "Sending…",
  "needs-attention": "Needs attention",
};

export function PendingIndicator({ store, version }: { store: OutboxStore; version: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ask = useAsk();
  const toast = useToast();
  // version is the redraw key: pending() is read fresh on every render.
  void version;
  const items = store.pending();
  const offline = store.offline();
  if (!items.length && !offline) return null;

  const attention = items.filter((i) => i.state === "needs-attention").length;
  const sending = items.some((i) => i.state === "syncing");
  const Icon = attention ? AlertTriangle : sending ? RefreshCw : CloudOff;
  const text = attention
    ? `${attention} need${attention === 1 ? "s" : ""} attention`
    : items.length
      ? `${items.length} on this device`
      : "Offline";

  const download = async (item: PendingChange) => {
    try {
      const { name, blob } = await store.exportPending(item.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast.error(message(err));
    }
  };

  const discard = async (item: PendingChange) => {
    const yes = await ask.confirm({
      title: "Throw this away?",
      description: "It isn't in your Roll, so once it's gone from this device it's gone. Download it first if you might want it.",
      confirmLabel: "Throw away",
      destructive: true,
    });
    if (!yes) return;
    try {
      await store.discardPending(item.id);
    } catch (err) {
      toast.error(message(err));
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      await store.syncPending();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "tap-target inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            "hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            attention ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <Icon className={cn("size-3.5", sending && "animate-spin")} aria-hidden="true" />
          <span className="max-sm:sr-only">{text}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Kept on this device</p>
            <p className="text-xs text-muted-foreground">
              {items.length
                ? "These aren't in your Roll yet. Each one is sent once, when this browser can reach your Roll."
                : "You're offline. What you save stays on this device until you're back online."}
            </p>
          </div>

          {items.length > 0 && (
            <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="flex flex-col gap-1 rounded-md border border-border px-2.5 py-2">
                  <p className="truncate text-sm">
                    {item.kind === "edit" ? "Edit: " : ""}
                    {item.title || "Untitled"}
                  </p>
                  <p className={cn("text-xs", item.state === "needs-attention" ? "text-destructive" : "text-muted-foreground")}>
                    {STATE_TEXT[item.state]}
                    {item.attachments > 0 && ` · ${item.attachments === 1 ? "1 file" : `${item.attachments} files`} waiting`}
                    {" · "}
                    {relativeTime(new Date(item.createdAt).toISOString())}
                    {item.message && <span className="block">{item.message}</span>}
                  </p>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void download(item)}>
                      <Download aria-hidden="true" />
                      Download
                    </Button>
                    {item.state !== "syncing" && (
                      <Button variant="ghost" size="sm" onClick={() => void discard(item)}>
                        <Trash2 aria-hidden="true" />
                        Throw away
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {items.length > 0 && (
            <Button variant="secondary" size="sm" disabled={busy || sending} onClick={() => void retry()}>
              <RefreshCw className={cn((busy || sending) && "animate-spin")} aria-hidden="true" />
              {busy || sending ? "Sending…" : "Send now"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
