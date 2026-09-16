import type { ValidateSource } from "../core/validate.ts";
import { safeRead, walkFiles } from "./fs-safe.ts";
import { readTemplate } from "./template-file.ts";

/** Exposes a Roll's files to the validator. Skips .git and never follows symbolic links. */
export function fsSource(root: string): ValidateSource {
  const { files, links } = walkFiles(root);
  return { paths: files, links, read: (p) => safeRead(root, p).toString("utf8"), template: (p, source) => readTemplate(p, source) };
}
