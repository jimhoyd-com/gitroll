import { useMemo, useState } from "react";
import type { LoadedEntry } from "../../core/layout.ts";
import { recordsIn } from "../../core/fields.ts";
import { PEOPLE_COLLECTION, contacts } from "../../core/contacts.ts";
import { SearchIndex } from "../../core/search.ts";
import { plural } from "../lib/format.ts";
import { DocLink, Empty, PageHeader, dayText, tableClass, tdClass, thClass } from "./ViewParts.tsx";
import { Input, Label } from "./ui/input.tsx";

const linkClass = "rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The people in .gitroll/notes/people/, with vCard's names for their fields,
 * and when each was last in an event that links to them. The same view as
 * `gitroll contacts`; each name opens the person's record.
 */
export function ContactsPage({ notes, docs }: { notes: LoadedEntry[]; docs: LoadedEntry[] }) {
  const [query, setQuery] = useState("");
  const records = useMemo(() => recordsIn(notes, PEOPLE_COLLECTION), [notes]);
  const view = useMemo(() => contacts(query.trim() ? new SearchIndex(records).search(query) : records, docs), [records, docs, query]);

  if (!records.length) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Contacts" />
        <Empty title="No one here yet" command={'gitroll add people "Ada Lovelace" --field email=ada@example.com --field bday=1815-12-10'}>
          People are records in .gitroll/notes/people/, with vCard's field names: email, tel, adr, org, bday, anniversary, url and note. gitroll import vcf
          brings in an address book.
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Contacts" description="Records in .gitroll/notes/people/. Last contacted is the newest event that links to the person." />

      <div className="flex min-w-48 flex-col gap-1.5">
        <Label htmlFor="contacts-q">Filter</Label>
        <Input id="contacts-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words, or fields: org:acme has:bday" />
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {plural(view.contacts.length, "person", "people")}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className={tableClass}>
          <caption className="sr-only">Contacts</caption>
          <thead>
            <tr>
              {["Name", "Email", "Phone", "Organization", "Last contacted"].map((h) => (
                <th key={h} scope="col" className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.contacts.map((c) => (
              <tr key={c.path}>
                <th scope="row" className={`${tdClass} text-left font-normal`}>
                  <DocLink path={c.path}>{c.name}</DocLink>
                  {c.jobTitle && <span className="block text-xs text-muted-foreground">{c.jobTitle}</span>}
                </th>
                <td className={tdClass}>
                  {c.emails.map((e) => (
                    <a key={e} href={`mailto:${e}`} className={`${linkClass} block`}>
                      {e}
                    </a>
                  ))}
                </td>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {c.tels.map((t) => (
                    <a key={t} href={`tel:${t.replace(/[^\d+]/g, "")}`} className={`${linkClass} block`}>
                      {t}
                    </a>
                  ))}
                </td>
                <td className={tdClass}>{c.org ?? ""}</td>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {c.lastContacted && c.interactions[0] ? <DocLink path={c.interactions[0].path} className={linkClass}>{dayText(c.lastContacted)}</DocLink> : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
