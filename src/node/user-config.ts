// Settings that belong to the person using GitRoll on this computer, not to a
// Roll. Stored outside every Roll so they're never synced or shared:
// which Rolls exist and where, your display name, and your saved searches.
// No event data is ever stored here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandSavedSearches } from "../core/search.ts";
import { ConflictError, NotFoundError, UserError, slugify } from "../core/util.ts";

export interface UserConfig {
  version: 1;
  /** Name shown on events you log. Defaults to git user.name. */
  author?: string;
  defaultRoll?: string;
  /**
   * Where Quick Capture saves, chosen once and left alone. It is deliberately
   * not `defaultRoll`: the Roll you happen to be working in is not the Roll a
   * half-formed thought belongs in, and a capture window is exactly where that
   * mistake would go unnoticed.
   */
  captureRoll?: string;
  /** The global shortcut this person asked for, as they typed it. */
  captureShortcut?: string;
  rolls: Record<string, { path: string }>;
  /** Searches worth keeping, by name: gitroll find @open-incidents */
  searches?: Record<string, string>;
  /**
   * Non-GitHub backup addresses the user has confirmed are private. GitRoll can't
   * check their visibility, so it refuses to upload to them unless listed here.
   */
  trustedRemotes?: string[];
}

/** Features that are built but not part of this release. Enable with GITROLL_EXPERIMENTAL=<name> */
export function experimental(feature: string): boolean {
  return (process.env.GITROLL_EXPERIMENTAL ?? "").split(",").map((s) => s.trim()).includes(feature);
}

export function configDir(): string {
  if (process.env.GITROLL_HOME) return path.resolve(process.env.GITROLL_HOME);
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "GitRoll");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "gitroll");
}

/** Where `gitroll new` puts Rolls unless told otherwise. */
export function rollsHome(): string {
  return process.env.GITROLL_ROLLS ? path.resolve(process.env.GITROLL_ROLLS) : path.join(os.homedir(), "GitRoll");
}

const configFile = () => path.join(configDir(), "config.json");

export function loadUserConfig(): UserConfig {
  try {
    const data = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<UserConfig>;
    return { ...data, version: 1, rolls: data.rolls && typeof data.rolls === "object" ? data.rolls : {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rolls: {} };
    throw new UserError(`Couldn't read your GitRoll settings at ${configFile()}: ${(e as Error).message}`);
  }
}

export function saveUserConfig(config: UserConfig): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${configFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configFile());
}

export function rollKey(name: string): string {
  const key = slugify(name);
  if (!key) throw new UserError("Please give the Roll a name.");
  return key;
}

export function addRoll(name: string, dir: string, makeDefault = false): string {
  const config = loadUserConfig();
  const key = rollKey(name);
  config.rolls[key] = { path: path.resolve(dir) };
  if (makeDefault || !config.defaultRoll || !config.rolls[config.defaultRoll]) config.defaultRoll = key;
  saveUserConfig(config);
  return key;
}

export function findRoll(name: string): { key: string; path: string } {
  const config = loadUserConfig();
  const key = rollKey(name);
  const hit = config.rolls[key];
  if (!hit) {
    const known = Object.keys(config.rolls);
    throw new UserError(`There's no Roll called "${name}".${known.length ? ` Your Rolls: ${known.join(", ")}` : " Create one with: gitroll new"}`);
  }
  return { key, path: hit.path };
}

// Saved searches belong to the person, not to a Roll: they live here, beside
// the list of Rolls, so `gitroll find @name --all` and the browser app's All
// Rolls search can run one over every Roll on this computer.

/** `gitroll find "…" --save <name>`: keeps a search under a name, replacing one already called that. */
export function saveSearch(name: string, query: string): string {
  const key = searchKey(name);
  if (!query.trim()) throw new UserError("There's nothing to save. Type a search first.");
  const config = loadUserConfig();
  config.searches = { ...config.searches, [key]: query.trim() };
  saveUserConfig(config);
  return key;
}

/** Gives a saved search a new name. Never over another saved search. */
export function renameSearch(from: string, to: string): string {
  const config = loadUserConfig();
  const old = searchKey(from);
  const key = searchKey(to);
  if (!config.searches || !Object.hasOwn(config.searches, old)) throw new NotFoundError(`There's no saved search called "${from}".`);
  if (key === old) return key;
  if (Object.hasOwn(config.searches, key)) throw new ConflictError(`There's already a saved search called "${key}". Choose another name.`);
  const searches: Record<string, string> = {};
  // Keep its place in the list.
  for (const [k, q] of Object.entries(config.searches)) searches[k === old ? key : k] = q;
  config.searches = searches;
  saveUserConfig(config);
  return key;
}

/** `gitroll searches remove <name>`. */
export function removeSearch(name: string): string {
  const config = loadUserConfig();
  const key = searchKey(name);
  if (!config.searches || !Object.hasOwn(config.searches, key)) throw new NotFoundError(`There's no saved search called "${name}".`);
  delete config.searches[key];
  saveUserConfig(config);
  return key;
}

function searchKey(name: string): string {
  const key = slugify(name.replace(/^@/, ""));
  if (!key) throw new UserError("Please give the search a name, like open-incidents.");
  return key;
}

/**
 * A query with every `@name` in it replaced by the search saved under that
 * name, so a saved search works in any command that takes a query, beside
 * other words and filters. One that isn't saved is an error, not a search that
 * finds nothing.
 */
export function expandQuery(query: string): string {
  if (!query.includes("@")) return query;
  const searches = loadUserConfig().searches ?? {};
  try {
    return expandSavedSearches(query, (name) => {
      const key = slugify(name);
      return Object.hasOwn(searches, key) ? searches[key] : undefined;
    });
  } catch (e) {
    if (e instanceof NotFoundError) throw new NotFoundError(`${e.message} See: gitroll searches`);
    throw e;
  }
}
