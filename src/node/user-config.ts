// Settings that belong to the person using GitRoll on this computer, not to a
// Roll. Stored outside every Roll so they're never synced or shared:
// which Rolls exist and where, your display name, and your local AI settings.
// No event data is ever stored here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError, slugify } from "../core/util.ts";

export interface AiSettings {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1 */
  endpoint: string;
  model: string;
  /**
   * The name of an environment variable holding an API key. The key itself is
   * never stored here, and never in a Roll: GitRoll reads the variable when it
   * makes a request and nothing else.
   */
  apiKeyEnv?: string;
  /** Allow a non-local endpoint. Off by default: events stay on this computer. */
  allowRemote?: boolean;
  /** Which preset this came from, so interfaces can show it by name. */
  provider?: string;
  /** Turned off without forgetting the settings. Ask stays unavailable until it is on again. */
  enabled?: boolean;
}

/** Ask is usable when it is set up and not switched off. */
export const aiOn = (ai: AiSettings | undefined): boolean => !!ai && ai.enabled !== false;

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
  ai?: AiSettings;
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
