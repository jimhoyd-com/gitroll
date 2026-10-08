import { CircleCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { isIssue, issues } from "../../core/issues.ts";
import type { Issue } from "../../core/issues.ts";
import { SearchIndex } from "../../core/search.ts";
import { isoDate } from "../../core/util.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, dayText, shortPath, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Input, Label } from "./ui/input.tsx";
import { QueryError, useSavedQuery } from "./SavedSearches.tsx";

const linkClass = "rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function State({ issue }: { issue: Issue }) {
  if (issue.status === "open") return <span className="font-medium">{issue.age !== null ? `Open ${plural(issue.age, "day", "days")}` : "Open"}</span>;
  const by = issue.resolvedBy[0];
  return (
    <span className="text-muted-foreground">
      Resolved{issue.resolved ? ` ${dayText(issue.resolved)}` : ""}
      {by && (
        <>
          {" "}by{" "}
          <DocLink path={by.path} className={linkClass}>
            {by.title}
          </DocLink>
        </>
      )}
    </span>
  );
}

/**
 * Open issues: events and notes marked `issue: open`, until `resolved:` says
 * otherwise or an event's `resolves:` links to one. Newest activity first,
 * with how long each has been open and the events that link to it. The same
 * view as `gitroll issues`, and Resolve does what `gitroll close` does.
 */
export function IssuesPage({ docs, onResolve }: { docs: LoadedEntry[]; onResolve?: (issue: Issue) => void }) {
  const [query, setQuery] = useState("");
  const saved = useSavedQuery(query);
  const [all, setAll] = useState(false);
  const today = isoDate();
  const view = useMemo(() => issues(saved.query.trim() ? new SearchIndex(docs).search(saved.query) : docs, docs, today, { all }), [docs, saved.query, all, today]);
  const any = useMemo(() => docs.some(isIssue), [docs]);

  if (!any) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Issues" />
        <Empty title="No issues here yet" command="gitroll set <event> issue=open">
          An issue is something that went wrong and stays open until it's resolved: an event or note with issue: open in its front matter. It's
          resolved by resolved: with a date, or by a later event whose resolves: links to it.
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Issues"
        description="Events and notes with issue: open. Each stays open until resolved: is set on it or a later event's resolves: links to it; activity is the events that link to it."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="issues-q">Filter</Label>
          <Input id="issues-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or fields: topic:car tag:leak" />
          <QueryError error={saved.error} />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="size-4 accent-primary" />
          Show resolved issues
        </label>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {plural(view.open, "open issue", "open issues")}
        {view.resolved > 0 && `, ${view.resolved} resolved`}
      </p>

      {view.issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">{query.trim() ? "No issue matches that." : "Nothing open. Every issue has been resolved."}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className={tableClass}>
            <caption className="sr-only">Issues, newest activity first</caption>
            <thead>
              <tr>
                {["Issue", "State", "Activity", ""].map((h, i) => (
                  <th key={i} scope="col" className={thClass}>
                    {h || <span className="sr-only">Resolve</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.issues.map((i) => (
                <tr key={i.path}>
                  <th scope="row" className={`${tdClass} text-left font-normal`}>
                    <DocLink path={i.path}>{i.title}</DocLink>
                    <span className="block text-xs text-muted-foreground">
                      {i.opened ? `Opened ${dayText(i.opened)}` : i.kind === "note" ? "A note" : "Undated"} · {shortPath(i.path)}
                    </span>
                  </th>
                  <td className={tdClass}>
                    <State issue={i} />
                  </td>
                  <td className={tdClass}>
                    {i.activity.length ? (
                      <>
                        {plural(i.activity.length, "event", "events")}, last{" "}
                        <DocLink path={i.activity[0].path} className={linkClass}>
                          {i.activity[0].date ? dayText(i.activity[0].date.slice(0, 10)) : i.activity[0].title}
                        </DocLink>
                      </>
                    ) : (
                      <span className="text-muted-foreground">None yet</span>
                    )}
                  </td>
                  <td className={`${tdClass} text-right`}>
                    {onResolve && i.status === "open" && (
                      <Button size="sm" variant="secondary" onClick={() => onResolve(i)} aria-label={`Resolve ${i.title}`}>
                        <CircleCheck aria-hidden="true" />
                        Resolve
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
