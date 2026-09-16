// Getting a Roll to somewhere that isn't this computer.
//
// The destination can be a folder — a drive, a share, a second machine — or a
// git URL. A folder needs no account and no software, which makes it the first
// backup most people can actually do; it only has to be a repository before
// anything can be pushed to it, and that is a thing to do rather than a thing
// to know, so GitRoll does it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "../core/util.ts";
import { isLocalDestination } from "./repo.ts";

export interface PreparedBackup {
  /** What to hand to `git remote add`. */
  url: string;
  /** True when GitRoll made the repository just now, which is worth saying. */
  created: boolean;
}

export function prepareBackup(destination: string): PreparedBackup {
  const given = destination.trim();
  if (!given) throw new UserError("Where should this Roll be backed up? A folder, or the address of an empty repository.");
  if (!isLocalDestination(given)) return { url: given, created: false };

  const dir = path.resolve(given.replace(/^file:\/\//, ""));
  if (fs.existsSync(path.join(dir, "HEAD")) || fs.existsSync(path.join(dir, ".git"))) return { url: dir, created: false };
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    throw new UserError(`${dir} already has files in it, so GitRoll won't back up into it. Pick an empty folder, or one that doesn't exist yet.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", dir], { stdio: ["ignore", "ignore", "pipe"] });
  return { url: dir, created: true };
}
