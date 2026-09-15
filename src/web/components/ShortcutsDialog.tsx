import { COPY } from "../copy.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

const SHORTCUTS: [string, string][] = [
  ["N", "Log something"],
  ["/", "Search"],
  ["G then I", "Go to the timeline"],
  ["G then T", "Go to topics"],
  ["Ctrl or ⌘ + Enter", "Save what you're writing"],
  ["Ctrl or ⌘ + B", "Bold"],
  ["Ctrl or ⌘ + I", "Italic"],
  ["Ctrl or ⌘ + K", "Link"],
  ["Esc", "Close, or clear the search"],
  ["?", "Show this list"],
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{COPY.shortcutsTitle}</DialogTitle>
          <DialogDescription>Everything here can also be done with the mouse.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
