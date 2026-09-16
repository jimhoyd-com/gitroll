import { useEffect, useState } from "react";
import type { Store } from "../store.ts";
import { message } from "../lib/format.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

/*
  Naming the Roll.

  `gitroll log` makes a Roll on the spot rather than asking questions before a
  first entry, which is right — but it leaves something called "My Roll", and
  the browser is where somebody is most likely to notice and want it fixed. The
  name in the header is the obvious place to fix it, so that is what this is.

  Renaming here re-files it in the list of Rolls too, so the name typed in the
  browser is the name `--roll` takes in the terminal. The folder keeps its own
  name: a path is not a title, and GitRoll doesn't move somebody's files.
*/

export interface RollNameProps {
  store: Store;
  name: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRenamed(): void;
}

export function RollName({ store, name, open, onOpenChange, onRenamed }: RollNameProps) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Whatever it is called now is what the box starts with, each time it opens.
  useEffect(() => {
    if (open) {
      setValue(name);
      setError("");
    }
  }, [open, name]);

  const save = () => {
    const next = value.trim();
    if (!next || busy || !store.rename) return;
    setBusy(true);
    void store
      .rename(next)
      .then(() => {
        onRenamed();
        onOpenChange(false);
      })
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Name this Roll</DialogTitle>
          <DialogDescription>
            What you call it here is what the terminal calls it too. Its folder keeps the name it has — GitRoll never moves your
            files.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="What should this Roll be called?"
            placeholder="Home"
            className="rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim() || value.trim() === name}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
