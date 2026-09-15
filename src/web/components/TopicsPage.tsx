import { Plus } from "lucide-react";
import { useMemo } from "react";
import type { LoadedEntry, Project } from "../../core/layout.ts";
import { COPY } from "../copy.ts";
import { dayLabel, plural } from "../lib/format.ts";
import { timelineHref } from "../hooks/useStore.ts";
import { Button } from "./ui/button.tsx";

export interface TopicsPageProps {
  entries: LoadedEntry[];
  projects: Project[];
  onCreate(): void;
}

export function TopicsPage({ entries, projects, onCreate }: TopicsPageProps) {
  const rows = useMemo(() => {
    // An event may name a topic that has no file of its own; the slug is then
    // the name. Those still belong in this list.
    const known = new Map(projects.map((p) => [p.slug, p.name]));
    for (const slug of entries.flatMap((e) => e.projects)) if (!known.has(slug)) known.set(slug, slug);
    return [...known]
      .map(([slug, name]) => {
        const mine = entries.filter((e) => e.projects.includes(slug));
        return { slug, name, count: mine.length, last: mine[0]?.occurred };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [entries, projects]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{COPY.topics}</h1>
        <Button variant="secondary" onClick={onCreate}>
          <Plus aria-hidden="true" />
          {COPY.newTopic}
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-6">
          <p className="text-sm text-muted-foreground">{COPY.topicsEmpty}</p>
          <Button onClick={onCreate}>
            <Plus aria-hidden="true" />
            {COPY.newTopic}
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((p) => (
            <li key={p.slug}>
              <a
                href={timelineHref(`topic:${p.slug}`)}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {plural(p.count, "event", "events")}
                  {p.last ? ` · ${dayLabel(new Date(p.last))}` : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
