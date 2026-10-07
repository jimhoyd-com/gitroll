import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { recordsIn } from "../../core/fields.ts";
import { ORGANIZATIONS_COLLECTION, organizations } from "../../core/organizations.ts";
import { SearchIndex } from "../../core/search.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, dayText, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Input, Label } from "./ui/input.tsx";

const linkClass = "rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Only web addresses become links; anything else in `url` is shown as written. */
const isWeb = (s: string) => /^https?:\/\//i.test(s);

/**
 * The organizations in .gitroll/notes/organizations/, with schema.org's names
 * for their fields, the people whose `org` names or links each, and when each
 * was last in an event that links to it. The same view as `gitroll organizations`.
 */
export function OrganizationsPage({ notes, docs }: { notes: LoadedEntry[]; docs: LoadedEntry[] }) {
  const [query, setQuery] = useState("");
  const records = useMemo(() => recordsIn(notes, ORGANIZATIONS_COLLECTION), [notes]);
  const view = useMemo(() => organizations(query.trim() ? new SearchIndex(records).search(query) : records, docs), [records, docs, query]);

  if (!records.length) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Organizations" />
        <Empty title="No organizations here yet" command={'gitroll add organizations "Acme" --field url=https://acme.example'}>
          Organizations are records in .gitroll/notes/organizations/, with schema.org's field names: url, email, telephone, address, foundingDate and
          parentOrganization. A person whose org names one, or links to it, is listed with it.
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Organizations"
        description="Records in .gitroll/notes/organizations/. People are the contacts whose org names or links to it; last contacted is the newest event that links to it."
      />

      <div className="flex min-w-48 flex-col gap-1.5">
        <Label htmlFor="organizations-q">Filter</Label>
        <Input id="organizations-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or fields: has:url foundingDate<2000" />
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {plural(view.organizations.length, "organization", "organizations")}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className={tableClass}>
          <caption className="sr-only">Organizations</caption>
          <thead>
            <tr>
              {["Name", "Website", "Phone and email", "People", "Last contacted"].map((h) => (
                <th key={h} scope="col" className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.organizations.map((o) => (
              <tr key={o.path}>
                <th scope="row" className={`${tdClass} text-left font-normal`}>
                  <DocLink path={o.path}>{o.name}</DocLink>
                  {o.parent && (
                    <span className="block text-xs text-muted-foreground">
                      Part of {o.parent.path ? <DocLink path={o.parent.path} className={linkClass}>{o.parent.name}</DocLink> : o.parent.name}
                    </span>
                  )}
                  {o.addresses[0] && <span className="block text-xs text-muted-foreground">{o.addresses[0]}</span>}
                </th>
                <td className={tdClass}>
                  {o.urls.map((u) =>
                    isWeb(u) ? (
                      <a key={u} href={u} rel="noreferrer noopener" target="_blank" className={`${linkClass} block`}>
                        {u.replace(/^https?:\/\//i, "")}
                      </a>
                    ) : (
                      <span key={u} className="block">
                        {u}
                      </span>
                    ),
                  )}
                </td>
                <td className={tdClass}>
                  {o.telephones.map((t) => (
                    <a key={t} href={`tel:${t.replace(/[^\d+]/g, "")}`} className={`${linkClass} block whitespace-nowrap`}>
                      {t}
                    </a>
                  ))}
                  {o.emails.map((e) => (
                    <a key={e} href={`mailto:${e}`} className={`${linkClass} block`}>
                      {e}
                    </a>
                  ))}
                </td>
                <td className={tdClass}>
                  {o.members.map((m) => (
                    <span key={m.path} className="block">
                      <DocLink path={m.path} className={linkClass}>
                        {m.name}
                      </DocLink>
                      {(m.jobTitle || m.units) && <span className="text-xs text-muted-foreground"> · {[m.jobTitle, m.units].filter(Boolean).join(", ")}</span>}
                    </span>
                  ))}
                </td>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {o.lastContacted && o.interactions[0] ? <DocLink path={o.interactions[0].path} className={linkClass}>{dayText(o.lastContacted)}</DocLink> : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
