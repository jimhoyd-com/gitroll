import type { ValidateSource } from "../core/validate.ts";
import { safeRead, walkFiles } from "./fs-safe.ts";
import { gunzipText } from "./gzip.ts";

/** Exposes a Roll's files to the validator. Skips .git and never follows symbolic links. */
export function fsSource(root: string): ValidateSource {
  const { files, links } = walkFiles(root);
  return {
    paths: files,
    links,
    // An archived segment is Markdown that happens to be compressed; the
    // checks are the same ones, so it is decompressed here rather than skipped.
    read: (p) => (p.endsWith(".gz") ? gunzipText(safeRead(root, p)) : safeRead(root, p).toString("utf8")),
  };
}
