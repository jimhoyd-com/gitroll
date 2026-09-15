import { HelpCircle, Search, Sparkles, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { serialize, tokenize } from "../../core/search.ts";
import type { Token } from "../../core/search.ts";
import type { EventType } from "../../core/types.ts";
import { typeFor } from "../../core/types.ts";
import { fmtAmount, localDay } from "../lib/format.ts";
import { FILTER_KEYS, removeToken, replaceTokenAtCaret, suggest, tokenAtCaret, toggleFilter, withoutKeys } from "../lib/query.ts";
import type { SuggestContext, Suggestion } from "../lib/query.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover.tsx";

export interface QueryBarProps {
  query: string;
  onQueryChange(next: string): void;
  suggestCtx: SuggestContext;
  registry: Map<string, EventType>;
  projectName(slug: string): string;
  resultCount: number;
  totals: Map<string, number>;
  askEnabled: boolean;
  onAsk(question: string): void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function QueryBar({
  query,
  onQueryChange,
  suggestCtx,
  registry,
  projectName,
  resultCount,
  totals,
  askEnabled,
  onAsk,
  inputRef,
}: QueryBarProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const listboxId = useId();

  const fragment = useMemo(() => tokenAtCaret(query, caret).text, [query, caret]);
  const suggestions = useMemo(() => (open ? suggest(fragment, suggestCtx).slice(0, 12) : []), [open, fragment, suggestCtx]);
  const [active, setActive] = useState(0);

  // Whatever is being typed changed, so the highlighted suggestion starts over.
  useEffect(() => setActive(0), [fragment, open]);
  const activeIndex = suggestions.length ? Math.min(active, suggestions.length - 1) : -1;
  const optionId = (i: number) => `${listboxId}-option-${i}`;

  const tokens = useMemo(() => tokenize(query), [query]);
  const filters = tokens.filter((t) => t.key);
  const words = tokens.filter((t) => !t.key);

  const choose = (insert: string) => {
    const next = replaceTokenAtCaret(query, caret, insert);
    onQueryChange(next.value);
    setOpen(insert.endsWith(":")); // a bare key still needs its value
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0);

  /*
    The suggestion list is driven from here rather than by the list itself.
    The text field is the only thing focus ever moves to, so the list has to be
    operated through it: arrow keys move the highlight, Enter takes it, and
    aria-activedescendant tells a screen reader which one is highlighted. That
    is the ARIA combobox pattern, and it means the whole thing works without a
    mouse (WCAG 2.1.1).
  */
  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    const showing = open && suggestions.length > 0;
    if (ev.key === "ArrowDown" && showing) {
      ev.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (ev.key === "ArrowUp" && showing) {
      ev.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (showing && activeIndex >= 0) choose(suggestions[activeIndex].insert);
      else setOpen(false);
    } else if (ev.key === "Tab" && showing && activeIndex >= 0) {
      // Tab completes the highlighted suggestion, the way a shell would.
      ev.preventDefault();
      choose(suggestions[activeIndex].insert);
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      if (open) setOpen(false);
      else if (query) onQueryChange("");
    } else if (ev.key === "Home" || ev.key === "End") {
      requestAnimationFrame(syncCaret);
    }
  };

  return (
    <div role="search" className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Popover open={open && suggestions.length > 0} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3 shadow-sm",
                "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
              )}
            >
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={ref}
                id="q"
                type="text"
                role="combobox"
                aria-expanded={open && suggestions.length > 0}
                aria-controls={listboxId}
                aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
                aria-autocomplete="list"
                aria-label="Search your Roll"
                aria-describedby={`${listboxId}-help`}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                placeholder="Search, or type a filter like has:photo"
                className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground max-sm:text-base"
                value={query}
                onChange={(ev) => {
                  onQueryChange(ev.target.value);
                  setCaret(ev.target.selectionStart ?? 0);
                  setOpen(true);
                }}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
              />
              {query && (
                <Button
                  variant="ghost"
                  size="iconSm"
                  onClick={() => {
                    onQueryChange("");
                    ref.current?.focus();
                  }}
                >
                  <X aria-hidden="true" />
                  <span className="sr-only">Clear the search</span>
                </Button>
              )}
              <Button variant="ghost" size="iconSm" onClick={() => setHelpOpen(true)}>
                <HelpCircle aria-hidden="true" />
                <span className="sr-only">How search works</span>
              </Button>
            </div>
          </PopoverAnchor>

          <PopoverContent
            className="w-[min(30rem,calc(100vw-2rem))] p-1"
            onOpenAutoFocus={(ev) => ev.preventDefault()}
          >
            <ul id={listboxId} role="listbox" aria-label="Search suggestions">
              {groupBy(suggestions).map(([group, items]) => (
                <li key={group} role="presentation">
                  <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground" id={`${listboxId}-${group}`}>
                    {group}
                  </p>
                  <ul role="group" aria-labelledby={`${listboxId}-${group}`}>
                    {items.map((s) => {
                      const i = suggestions.indexOf(s);
                      return (
                        <li
                          key={s.insert}
                          id={optionId(i)}
                          role="option"
                          aria-selected={i === activeIndex}
                          onMouseDown={(ev) => {
                            // Keep focus in the text field: moving it would close
                            // the list before the click landed.
                            ev.preventDefault();
                            choose(s.insert);
                          }}
                          onMouseEnter={() => setActive(i)}
                          className={cn(
                            "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-sm",
                            i === activeIndex && "bg-accent text-accent-foreground",
                          )}
                        >
                          <span className="truncate">{s.label}</span>
                          {s.hint && <span className="ml-auto truncate pl-3 font-mono text-xs text-muted-foreground">{s.hint}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>

        {askEnabled && (
          <Button variant="secondary" className="h-11 shrink-0" onClick={() => onAsk(serialize(words))}>
            <Sparkles aria-hidden="true" />
            <span className="max-sm:sr-only">Ask</span>
          </Button>
        )}
      </div>

      <p id={`${listboxId}-help`} className="sr-only">
        Type words to search. Type a filter such as topic, tag, type, has, after, before or amount, followed by a colon, to narrow
        the results. Suggestions appear as you type; use the arrow keys to choose one.
      </p>

      <QuickFilters query={query} onQueryChange={onQueryChange} />

      {filters.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Filters you've applied">
          {filters.map((t, i) => (
            <li key={`${t.key}:${t.value}:${i}`}>
              <button
                type="button"
                onClick={() => onQueryChange(removeToken(query, t))}
                className={cn(
                  "tap-target inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs",
                  "text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                {filterLabel(t, registry, projectName)}
                <X className="size-3 opacity-60" aria-hidden="true" />
                <span className="sr-only">Remove this filter</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        The result count is a live region: a search that narrows to nothing is
        otherwise silent for anyone not watching the list (WCAG 4.1.3).
      */}
      <p role="status" aria-live="polite" className="min-h-5 text-xs text-muted-foreground">
        {query.trim() ? (
          <>
            {resultCount} {resultCount === 1 ? "event" : "events"}
            {[...totals].map(([currency, value]) => (
              <span key={currency}> · {fmtAmount({ value, currency })} in total</span>
            ))}
          </>
        ) : null}
      </p>

      <SearchHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

function groupBy(items: Suggestion[]): [string, Suggestion[]][] {
  const map = new Map<string, Suggestion[]>();
  for (const item of items) {
    const list = map.get(item.group) ?? [];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map];
}

/** The three filters worth a permanent button, as toggles over the query. */
function QuickFilters({ query, onQueryChange }: { query: string; onQueryChange(next: string): void }) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const year = String(now.getFullYear());
  const tokens = tokenize(query);
  const onValue = tokens.find((t) => t.key === "on")?.value;

  const setDate = (value: string) => {
    const cleared = withoutKeys(query, ["on", "after", "before"]);
    onQueryChange(onValue === value ? cleared : serialize([...tokenize(cleared), { key: "on", value }]));
  };

  const chips: { label: string; on: boolean; toggle(): void }[] = [
    { label: "Today", on: onValue === localDay(now), toggle: () => setDate(localDay(now)) },
    { label: "This month", on: onValue === month, toggle: () => setDate(month) },
    { label: "This year", on: onValue === year, toggle: () => setDate(year) },
    {
      label: "With a photo",
      on: tokens.some((t) => t.key === "has" && t.value === "photo"),
      toggle: () => onQueryChange(toggleFilter(query, "has", "photo")),
    },
  ];

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          aria-pressed={c.on}
          onClick={c.toggle}
          className={cn(
            "tap-target rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            c.on ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function filterLabel(t: Token, registry: Map<string, EventType>, projectName: (slug: string) => string): string {
  switch (t.key) {
    case "project":
      return projectName(t.value);
    case "tag":
      return `#${t.value}`;
    case "type":
      return typeFor(registry, t.value).label;
    case "author":
      return `By ${t.value}`;
    case "after":
      return `After ${t.value}`;
    case "before":
      return `Before ${t.value}`;
    case "on":
      return t.value;
    case "has":
      return `With ${t.value}`;
    case "amount":
      return `Amount ${t.value}`;
    default:
      return `${t.key}: ${t.value}`;
  }
}

function SearchHelp({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Searching your Roll</DialogTitle>
          <DialogDescription>
            Type words to find them anywhere in an event. Add a filter to narrow things down — they stack, and suggestions appear
            as you type.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {FILTER_KEYS.map((k) => (
            <div key={k.key} className="contents">
              <dt className="font-mono text-xs text-foreground">{k.example}</dt>
              <dd className="text-muted-foreground">{k.hint}</dd>
            </div>
          ))}
          <div className="contents">
            <dt className="font-mono text-xs text-foreground">#plumbing</dt>
            <dd className="text-muted-foreground">Short for tag:plumbing</dd>
          </div>
          <div className="contents">
            <dt className="font-mono text-xs text-foreground">vendor:carlos</dt>
            <dd className="text-muted-foreground">Any field a type defines</dd>
          </div>
          <div className="contents">
            <dt className="font-mono text-xs text-foreground">"two words"</dt>
            <dd className="text-muted-foreground">An exact phrase</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Same filters the <code className="font-mono">gitroll find</code> command uses, so a search that works here works in your
          terminal.
        </p>
      </DialogContent>
    </Dialog>
  );
}
