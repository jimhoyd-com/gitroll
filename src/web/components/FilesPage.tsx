import { FileText, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { SEALED_SUFFIX } from "../../core/sealed.ts";
import { fmtSize, plural } from "../lib/format.ts";
import type { FileItem } from "../store.ts";
import { SealedFileButton } from "../unseal.tsx";
import { DocLink, Empty, PageHeader, fieldText, shortPath } from "./ViewParts.tsx";
import { Button } from "./ui/button.tsx";
import { Input, Label } from "./ui/input.tsx";

const HIDDEN_FIELDS = new Set(["title", "sha256", "parts", "size"]);

/**
 * Every file in .gitroll/files/: photos, scans, manuals, with or without an
 * event. A file nothing links to is unfiled, waiting to be described or linked
 * rather than lost. The same list as `gitroll files`.
 */
export function FilesPage({ files, fileUrl }: { files: FileItem[]; fileUrl(path: string): string }) {
  const [unfiledOnly, setUnfiledOnly] = useState(false);
  const [query, setQuery] = useState("");
  const unfiled = useMemo(() => files.filter((f) => f.unfiled).length, [files]);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return files.filter(
      (f) =>
        (!unfiledOnly || f.unfiled) &&
        (!words || `${f.title} ${f.path} ${Object.values(f.fields).map(fieldText).join(" ")}`.toLowerCase().includes(words)),
    );
  }, [files, unfiledOnly, query]);

  if (!files.length) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Files" />
        <Empty title="No files yet" command="gitroll attach passport.pdf --field title=Passport">
          Photos and files you add to an event are kept in .gitroll/files/. A file can also go in on its own:
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Files"
        description="Everything in .gitroll/files/. A file's fields live beside it, in a note named after it (passport.pdf.md)."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="files-q">Filter</Label>
          <Input id="files-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, title or a field's value" />
        </div>
        <Button size="sm" variant={unfiledOnly ? "default" : "ghost"} aria-pressed={unfiledOnly} onClick={() => setUnfiledOnly((v) => !v)}>
          Unfiled ({unfiled})
        </Button>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {plural(shown.length, "file", "files")}
      </p>

      <ul className="flex flex-col gap-2">
        {shown.map((f) => {
          const sealed = f.path.endsWith(SEALED_SUFFIX);
          const fields = Object.entries(f.fields).filter(([k, v]) => !HIDDEN_FIELDS.has(k) && fieldText(v));
          return (
            <li key={f.path} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
              {sealed ? <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {f.missing ? (
                    f.title
                  ) : (
                    <a href={fileUrl(f.path)} target="_blank" rel="noopener" className="rounded underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {f.title}
                    </a>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    shortPath(f.path),
                    f.size !== null ? fmtSize(f.size) || "0 B" : "",
                    f.parts ? `in ${f.parts} parts` : "",
                    sealed ? "sealed" : "",
                    f.missing ? "the file isn't here, only its fields" : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {sealed && !f.missing && <SealedFileButton path={f.path} name={f.path.split("/").pop() ?? f.path} url={fileUrl(f.path)} />}
                {fields.length > 0 && (
                  <p className="mt-1 text-xs">
                    {fields.map(([k, v], n) => (
                      <span key={k}>
                        {n > 0 && <span className="text-muted-foreground"> · </span>}
                        <span className="text-muted-foreground">{k}</span> {fieldText(v)}
                      </span>
                    ))}
                  </p>
                )}
                <p className="mt-1 text-xs">
                  {f.unfiled ? (
                    <span className="text-muted-foreground">Unfiled: nothing links to it yet.</span>
                  ) : (
                    <>
                      <span className="text-muted-foreground">Linked from </span>
                      {f.linkedFrom.map((p, n) => (
                        <span key={p}>
                          {n > 0 && ", "}
                          <DocLink path={p}>{shortPath(p)}</DocLink>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
