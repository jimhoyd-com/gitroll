// Every read and write inside a Roll goes through these checks, so a Roll that
// contains symbolic links (by accident or on purpose) can't make GitRoll read
// or write anywhere outside its own folder.

import fs from "node:fs";
import path from "node:path";
import { UserError } from "../core/util.ts";

export class UnsafePathError extends UserError {}

/**
 * Resolves `rel` inside `root` (which must already be a real path) and refuses
 * paths that escape the root or pass through a symbolic link.
 */
export function insideRoll(rollRoot: string, rel: string): string {
  const root = path.resolve(rollRoot);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new UnsafePathError(`Refusing a path outside the Roll: ${rel}`);
  let current = root;
  for (const part of path.relative(root, abs).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break; // the rest doesn't exist yet
      throw e;
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafePathError(`GitRoll doesn't follow symbolic links. Remove the link at ${path.relative(root, current)}.`);
    }
  }
  return abs;
}

export function safeRead(root: string, rel: string): Buffer {
  return fs.readFileSync(insideRoll(root, rel));
}

export function safeWrite(root: string, rel: string, content: string | Uint8Array): void {
  const abs = insideRoll(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  insideRoll(root, rel); // re-check after creating parents
  fs.writeFileSync(abs, content);
}

export function safeRemove(root: string, rel: string): void {
  fs.rmSync(insideRoll(root, rel), { force: true });
}

/** Lists plain files under a directory. Symbolic links are reported, never followed. */
export function walkFiles(rollRoot: string, relDir = ""): { files: string[]; links: string[] } {
  const root = path.resolve(rollRoot);
  const files: string[] = [];
  const links: string[] = [];
  const visit = (rel: string) => {
    const abs = rel ? insideRoll(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const d of entries) {
      if (!rel && d.name === ".git") continue;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) links.push(child);
      else if (d.isDirectory()) visit(child);
      else if (d.isFile()) files.push(child);
    }
  };
  if (relDir) {
    try {
      if (fs.lstatSync(path.join(root, relDir)).isSymbolicLink()) return { files, links: [relDir] };
    } catch {
      return { files, links };
    }
  }
  visit(relDir);
  return { files, links };
}
