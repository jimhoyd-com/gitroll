// A permanent id for an entry.
//
// Under per-event storage an event's identity is its path, and that is enough:
// one file, one event, and `git mv` moves it. Inside a shared monthly or daily
// file there are no paths to go round, and an entry has to survive rollover,
// migration, archival and compression — so each one carries an id that depends
// on nothing outside itself.
//
// The id is a ULID: 10 characters of millisecond timestamp followed by 16 of
// randomness, in Crockford base32. It sorts by creation time when you read a
// file, which makes a segment pleasant to scan, and it is a single unquoted
// token in Markdown, YAML and a URL.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ENTRY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const encode = (value: number, length: number): string => {
  let out = "";
  let n = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
};

export type RandomBytes = (n: number) => Uint8Array;

const webRandom: RandomBytes = (n) => {
  const bytes = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

/** A new entry id. `now` and `random` are injectable so tests are deterministic. */
export function newEntryId(now: Date = new Date(), random: RandomBytes = webRandom): string {
  const time = encode(Math.max(0, now.getTime()), 10);
  const bytes = random(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += ALPHABET[bytes[i] % 32];
  return time + tail;
}

export const isEntryId = (s: string): boolean => ENTRY_ID.test(s.trim());

/**
 * A stable id for an entry that never had one — a file written by hand, or one
 * migrated from per-event storage. The same inputs always give the same id, so
 * two clones migrating the same repository agree without talking to each other.
 * `digest` is a hex SHA-256 supplied by the caller (Node or the browser).
 */
export function derivedEntryId(digest: string): string {
  const hex = digest.replace(/[^0-9a-f]/gi, "").toLowerCase();
  let bits = "";
  for (const ch of hex) bits += parseInt(ch, 16).toString(2).padStart(4, "0");
  let out = "";
  for (let i = 0; out.length < 26; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  // A derived id must not look like it sorts with real timestamps, but it must
  // still be a valid id; the first character is clamped the way ULID does.
  return ALPHABET[Math.min(7, ALPHABET.indexOf(out[0]))] + out.slice(1, 26);
}
