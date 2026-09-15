import { X } from "lucide-react";
import type { Attachment } from "../../core/entry.ts";
import type { LoadedEntry } from "../../core/layout.ts";
import { COPY } from "../copy.ts";
import { plural } from "../lib/format.ts";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/misc.tsx";
import { EntryCard } from "./Timeline.tsx";

export interface AskState {
  question: string;
  loading: boolean;
  answer: string;
  sources: { id: string; short: string }[];
  error: string;
}

export interface AskPanelProps {
  state: AskState;
  entries: LoadedEntry[];
  projectName(slug: string): string;
  attachmentUrl(a: Attachment): string;
  onFilter(key: string, value: string): void;
  onClose(): void;
}

export function AskPanel({ state, entries, projectName, attachmentUrl, onFilter, onClose }: AskPanelProps) {
  const cited = entries.filter((e) => state.sources.some((s) => s.id === e.id));

  return (
    <section
      aria-label="Answer"
      aria-busy={state.loading}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{state.question}</p>
        <Button variant="ghost" size="iconSm" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">{COPY.close}</span>
        </Button>
      </div>

      <div role="status" aria-live="polite">
        {state.loading ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{COPY.askThinking}</p>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : state.error ? (
          <p className="text-sm text-destructive">{state.error}</p>
        ) : (
          <Answer text={state.answer} sources={state.sources} />
        )}
      </div>

      {!state.loading && !state.error && (
        <p className="text-xs text-muted-foreground">{cited.length ? COPY.askCaveat : COPY.askNoSources}</p>
      )}

      {cited.length > 0 && (
        <div className="border-t border-border pt-2">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {plural(cited.length, "event", "events")} this came from
          </h3>
          <ul>
            {cited.map((e) => (
              <li key={e.id}>
                <EntryCard
                  entry={e}
                  projectName={projectName}
                  attachmentUrl={attachmentUrl}
                  onFilter={onFilter}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Turns the model's [abc12345] citations into links to those events. */
function Answer({ text, sources }: { text: string; sources: { id: string; short: string }[] }) {
  const byShort = new Map(sources.map((s) => [s.short, s.id]));
  const parts = text.split(/(\[[0-9a-f]{8}\])/g);
  return (
    <p className="whitespace-pre-wrap text-sm">
      {parts.map((part, i) => {
        const m = /^\[([0-9a-f]{8})\]$/.exec(part);
        const id = m ? byShort.get(m[1]) : undefined;
        if (!m) return <span key={i}>{part}</span>;
        if (!id) return null;
        return (
          <a
            key={i}
            href={`#/entry/${encodeURIComponent(id)}`}
            className="mx-0.5 rounded text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            the event
          </a>
        );
      })}
    </p>
  );
}
