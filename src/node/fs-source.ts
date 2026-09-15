import { createHash } from "node:crypto";
import type { ValidateSource } from "../core/validate.ts";
import { safeRead, walkFiles } from "./fs-safe.ts";

/** Exposes a Roll's files to the validator. Skips .git and never follows symbolic links. */
export function fsSource(root: string, verifyHashes = true): ValidateSource {
  const { files, links } = walkFiles(root);
  return {
    paths: files,
    links,
    read: (p) => safeRead(root, p).toString("utf8"),
    sha256: verifyHashes ? (p) => createHash("sha256").update(safeRead(root, p)).digest("hex") : undefined,
  };
}
