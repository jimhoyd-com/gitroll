import { COPY } from "../copy.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

const SHORTCUTS: [string, string][] = [
  ["N or /", "The box on Home: find, or record (on the timeline, / is its search)"],
  ["Tab, in the box", "Save it as another kind"],
  ["Enter, in the box", "Save what you typed"],
  ["Shift + Enter, in the box", "Open the full form for it"],
  ["↓, in the box", "Go to the results"],
  ["G then H", "Go home"],
  ["G then B", "Go to the Library"],
  ["G then L", "Go to the timeline"],
  ["G then R", "Go to records"],
  ["G then T", "Go to topics"],
  ["G then N", "Go to notes"],
  ["G then U", "Go to the calendar and to-dos"],
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
