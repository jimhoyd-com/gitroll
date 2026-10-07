import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ValidateSource } from "../core/validate.ts";
import { insideRoll, safeRead, walkFiles } from "./fs-safe.ts";
import { readTemplate } from "./template-file.ts";

/** Exposes a Roll's files to the validator. Skips .git and never follows symbolic links. */
export function fsSource(root: string): ValidateSource {
  const { files, links } = walkFiles(root);
  return {
    paths: files,
    links,
    read: (p) => safeRead(root, p).toString("utf8"),
    template: (p, source) => readTemplate(p, source),
    size: (p) => fs.lstatSync(insideRoll(root, p)).size,
    sha256: (paths) => sha256Of(paths.map((p) => insideRoll(root, p))),
  };
}

/** SHA-256 of files read one after another, as `cat a b | sha256sum` gives it. Read in chunks, so size doesn't matter. */
export function sha256Of(absPaths: string[]): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  for (const abs of absPaths) {
    const fd = fs.openSync(abs, "r");
    try {
      for (let n = fs.readSync(fd, chunk, 0, chunk.length, null); n > 0; n = fs.readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  }
  return hash.digest("hex");
}
