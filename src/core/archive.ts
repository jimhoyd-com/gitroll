// Which filing periods have been put out of the way.
//
// Archiving is a property of a whole period, not of one entry: a month is
// either in the timeline or out of it. The state is a small YAML file in the
// Roll, committed like everything else, and both the app and GitRoll.com have
// to read it the same way — one of them appending to a month somebody has
// finished with would put an entry where they would never look for it.

export const ARCHIVE_STATE = ".gitroll/archive.yaml";
export const ARCHIVE_STATE_VERSION = 1;

export interface PeriodArchive {
  archived: boolean;
  /** When it was archived, as an instant. */
  at?: string;
  compressed: boolean;
  /**
   * False after someone unarchived a period by hand: automatic archival leaves
   * it alone until they say otherwise, so a period they deliberately reopened
   * isn't closed again overnight.
   */
  auto: boolean;
}

export interface ArchiveState {
  version: number;
  periods: Record<string, PeriodArchive>;
}

export function parseArchiveYaml(text: string): ArchiveState {
  const state: ArchiveState = { version: ARCHIVE_STATE_VERSION, periods: {} };
  let period: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    const version = /^archive_version:\s*(\d+)/.exec(line);
    if (version) {
      state.version = Number(version[1]);
      continue;
    }
    const head = /^ {2}"?([0-9]{4}-[0-9]{2}(?:-[0-9]{2})?)"?:\s*$/.exec(line);
    if (head) {
      period = head[1];
      state.periods[period] = { archived: false, compressed: false, auto: true };
      continue;
    }
    const field = /^ {4}(\w+):\s*(.+)$/.exec(line);
    if (field && period) {
      const value = field[2].trim();
      const current = state.periods[period];
      if (field[1] === "archived") current.archived = value === "true";
      else if (field[1] === "compressed") current.compressed = value === "true";
      else if (field[1] === "auto") current.auto = value !== "false";
      else if (field[1] === "at") current.at = value;
    }
  }
  return state;
}

export function serializeArchiveYaml(state: ArchiveState): string {
  const lines = [
    "# Which filing periods are archived, and whether their files are compressed.",
    "# GitRoll writes this file; it is committed like everything else in .gitroll/.",
    `archive_version: ${ARCHIVE_STATE_VERSION}`,
    "periods:",
  ];
  for (const period of Object.keys(state.periods).sort()) {
    const p = state.periods[period];
    lines.push(`  "${period}":`);
    lines.push(`    archived: ${p.archived}`);
    lines.push(`    compressed: ${p.compressed}`);
    lines.push(`    auto: ${p.auto}`);
    if (p.at) lines.push(`    at: ${p.at}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The periods old enough to archive on their own.
 *
 * Measured from the end of the period in the Roll's own zone, so "30 days"
 * means thirty days after the month finished, not after its last entry. A
 * period somebody archived already, or reopened by hand, is left alone: their
 * decision stands until they say otherwise.
 */
export function dueForArchive(
  periods: Iterable<string>,
  state: ArchiveState,
  opts: { afterDays: number | null; periodEnd(period: string): Date; now: Date },
): string[] {
  if (!opts.afterDays) return [];
  const due: string[] = [];
  for (const period of new Set(periods)) {
    const current = state.periods[period];
    if (!period || current?.archived || current?.auto === false) continue;
    if (opts.now.getTime() - opts.periodEnd(period).getTime() >= opts.afterDays * 86_400_000) due.push(period);
  }
  return due.sort();
}

/** The periods a Roll has archived, from the file's text. */
export function archivedPeriodsIn(text: string): Set<string> {
  const { periods } = parseArchiveYaml(text);
  return new Set(Object.keys(periods).filter((period) => periods[period].archived));
}
