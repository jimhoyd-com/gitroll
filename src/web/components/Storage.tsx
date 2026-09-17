import { Archive, ArchiveRestore } from "lucide-react";
import { useEffect, useState } from "react";
import type { PeriodRow, StorageSettings, Store } from "../store.ts";
import { fmtSize, message, periodLabel, plural } from "../lib/format.ts";
import { Button } from "./ui/button.tsx";

/*
  Where the Roll's entries live, and putting a period out of the way.

  Archiving is not deleting and must never read like it: the files stay in the
  folder, the entries stay in Git, and a link to one keeps working. What changes
  is that a period stops appearing in the timeline and in search until somebody
  asks for it — which is the whole point when a Roll has years in it.

  Compression is a separate decision, and a real trade: smaller on disk, but no
  readable diff on GitHub and no preview. It is offered per archive rather than
  assumed, and said plainly next to the box — and only where the store can
  actually do it, rather than offering a box that would quietly do nothing.
*/

export interface StorageProps {
  store: Store;
  onChanged(): void;
}

export function Storage({ store, onChanged }: StorageProps) {
  const [rows, setRows] = useState<PeriodRow[] | null>(null);
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [compress, setCompress] = useState(false);
  const [canCompress, setCanCompress] = useState(true);
  const [recorded, setRecorded] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!store.periods) return;
    store
      .periods()
      .then(({ periods, settings: s, canCompress: can, recordedZone }) => {
        setRecorded(recordedZone);
        setRows(periods);
        setSettings(s);
        setCanCompress(can !== false);
        setCompress(can === false ? false : s.archive.compress);
      })
      .catch((e) => setError(message(e)));
  }, [store]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!rows || !settings) return null;

  const settle = () => {
    if (!store.setTimezone) return;
    setBusy("zone");
    void store
      .setTimezone(settings.timezone)
      .then((next) => {
        setSettings(next);
        setRecorded(next.timezone);
        onChanged();
      })
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(""));
  };

  const filedBy = settings.mode === "event" ? "entry" : settings.mode === "daily" ? "day" : "month";

  /*
    Which zone a logbook files by belongs to the Roll, not to whatever is
    reading it. Until it is written down, this computer says one thing and
    GitRoll.com says another, and an entry logged late in the evening can land
    on different days in the two. GitRoll doesn't settle it for somebody — the
    configuration file says it never changes it for you — so it says what it is
    assuming and offers the one-click way to make it true. A Roll with a file
    per entry has this question too, which is why it isn't inside the list.
  */
  const zoneNotice = recorded === null && (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        This Roll hasn't recorded which zone it files by, so each place you open it uses its own — and an entry logged late in the
        evening can land on a different day here than in the app. Writing it down records how this Roll already files — by{" "}
        {filedBy}, in {settings.timezone} — so every reader agrees. Nothing already filed moves.
      </p>
      {store.setTimezone && (
        <Button variant="secondary" size="sm" disabled={busy === "zone"} onClick={settle}>
          Always file in {settings.timezone}
        </Button>
      )}
    </div>
  );

  if (settings.mode === "event") {
    return (
      <section className="flex flex-col gap-3" aria-labelledby="storage-heading">
        <h2 id="storage-heading" className="text-sm font-semibold">
          Filing periods
        </h2>
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-6">
          <p className="text-sm">This Roll keeps one file per entry.</p>
          <p className="text-sm text-muted-foreground">
            Archiving works on filing periods — a month or a day of entries in one file. To group this Roll that way, run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">gitroll migrate --to monthly</code> in the terminal.
          </p>
        </div>
        {zoneNotice}
      </section>
    );
  }

  const act = (row: PeriodRow, archive: boolean) => {
    setBusy(row.period);
    const done = archive ? store.archivePeriod?.(row.period, compress) : store.unarchivePeriod?.(row.period);
    if (!done) return setBusy("");
    void done
      .then((next) => {
        setRows(next);
        onChanged();
      })
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(""));
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="storage-heading">
      <h2 id="storage-heading" className="text-sm font-semibold">
        Filing periods
      </h2>
      <p className="text-xs text-muted-foreground">
        Entries are filed by {settings.mode === "daily" ? "day" : "month"} in {settings.timezone}. Archiving a period takes it out of
        the timeline and out of search until you ask for it. Nothing is deleted, links keep working, and you can reopen it whenever
        you like.
      </p>

      {zoneNotice}

      {canCompress ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} className="size-3.5" />
          Compress when archiving — smaller on disk, but no readable diff on GitHub and no preview.
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          Archiving here leaves the files readable. To compress an archived period as well, archive it in the GitRoll app; reopening
          one that was compressed works here and makes it readable again.
        </p>
      )}

      {!rows.length && <p className="text-sm text-muted-foreground">Nothing filed yet.</p>}

      <ol className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.period} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {periodLabel(row.period)}
                {row.archived && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">archived</span>}
                {row.compressed && <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">compressed</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.period} · {plural(row.entries, "entry", "entries")} · {fmtSize(row.bytes)} · {plural(row.files, "file", "files")}
                {row.unreadable > 0 && ` · ${plural(row.unreadable, "file", "files")} GitRoll can't read`}
              </p>
            </div>
            <Button variant="secondary" size="sm" disabled={busy === row.period} onClick={() => act(row, !row.archived)}>
              {row.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
              {row.archived ? "Reopen" : "Archive"}
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
