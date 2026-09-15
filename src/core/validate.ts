import { FORMAT_VERSION, FormatError, parseEntry } from "./entry.ts";
import { ATTACHMENT_FILE, CONFIG_PATH, ENTRY_FILE, PROJECT_FILE, parseConfig } from "./layout.ts";
import type { Problem } from "./layout.ts";
import { TYPE_FILE, parseTypeDef, typeRegistry, validateData } from "./types.ts";
import type { EventType } from "./types.ts";
import { parse } from "yaml";

export interface ValidateSource {
  /** Every repository-relative path (posix separators), excluding .git. */
  paths: string[];
  read(path: string): string;
  /** Optional: SHA-256 hex of a file's bytes, to verify content addressing. */
  sha256?(path: string): string;
  /** Symbolic links found in the Roll. They're never followed and always reported. */
  links?: string[];
}

const IGNORED = /(^|\/)(\.gitkeep|\.DS_Store)$/;

/** Checks a log repository against the GitRoll Format. Returns an empty list when valid. */
export function validateRepo(src: ValidateSource): Problem[] {
  const problems: Problem[] = [];
  const add = (path: string, error: string) => problems.push({ path, error });
  const paths = [...new Set(src.paths)].sort();
  for (const link of src.links ?? []) add(link, "symbolic links aren't allowed in a Roll; replace it with the real file");

  if (!paths.includes(CONFIG_PATH)) add(CONFIG_PATH, "missing GitRoll config");
  else {
    try {
      const cfg = parseConfig(src.read(CONFIG_PATH), "");
      if (cfg.version > FORMAT_VERSION) add(CONFIG_PATH, `format version ${cfg.version} is newer than this validator (${FORMAT_VERSION})`);
    } catch (e) {
      add(CONFIG_PATH, `invalid YAML: ${(e as Error).message}`);
    }
  }

  const custom: EventType[] = [];
  const attachments = new Set<string>();
  for (const p of paths) {
    if (IGNORED.test(p)) continue;
    if (p.startsWith(".gitroll/types/")) {
      const m = TYPE_FILE.exec(p);
      if (!m) add(p, "type definitions must be .gitroll/types/<id>.yaml");
      else {
        try {
          custom.push(parseTypeDef(m[1], src.read(p)));
        } catch (e) {
          add(p, (e as Error).message);
        }
      }
    } else if (p.startsWith("attachments/")) {
      const m = ATTACHMENT_FILE.exec(p);
      if (!m) add(p, "attachment files must be named <sha256>.<ext>");
      else {
        attachments.add(m[1]);
        if (src.sha256 && src.sha256(p) !== m[1]) add(p, "content does not match its SHA-256 name");
      }
    } else if (p.startsWith("projects/")) {
      if (!PROJECT_FILE.test(p)) add(p, "project files must be projects/<slug>.yaml");
      else {
        try {
          parse(src.read(p));
        } catch (e) {
          add(p, `invalid YAML: ${(e as Error).message}`);
        }
      }
    }
  }

  const registry = typeRegistry(custom);
  const ids = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const p of paths) {
    if (!p.startsWith("entries/") || IGNORED.test(p)) continue;
    const m = ENTRY_FILE.exec(p);
    if (!m) {
      add(p, "entry files must be Markdown (.md)");
      continue;
    }
    try {
      const e = parseEntry(src.read(p));
      if (e.version > FORMAT_VERSION) add(p, `format version ${e.version} is newer than this validator`);
      if (m[1] !== e.id) add(p, `file name does not match id ${e.id}`);
      const dup = ids.get(e.id);
      if (dup) add(p, `duplicate id also used by ${dup}`);
      ids.set(e.id, p);
      if (e.source) {
        const key = `${e.source.adapter}:${e.source.id}`;
        const other = sources.get(key);
        if (other) add(p, `duplicate source ${key} also used by ${other}`);
        sources.set(key, p);
      }
      const type = registry.get(e.type);
      if (type) for (const err of validateData(type, e.data)) add(p, `data.${err}`);
      for (const a of e.attachments) {
        const hex = a.hash.replace(/^sha256:/, "");
        if (!/^[a-f0-9]{64}$/.test(hex)) add(p, `attachment ${a.name} has an invalid hash`);
        else if (!attachments.has(hex)) add(p, `attachment ${a.name} is missing (attachments/${hex}.*)`);
      }
    } catch (e) {
      add(p, e instanceof FormatError ? e.message : `unreadable: ${(e as Error).message}`);
    }
  }
  return problems;
}
