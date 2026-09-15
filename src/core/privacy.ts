// Privacy helpers that run before anything is committed to history.

/** Kinds of sensitive text that shouldn't live forever in Git history. */
const PATTERNS: [string, RegExp][] = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["API key", /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|[sr]k_live_[A-Za-z0-9]{20,})/],
  ["password", /\b(?:password|passwd|passcode|pin)\s*(?:is|[:=])\s*\S{4,}/i],
  ["Social Security number", /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Returns the kinds of sensitive data that appear in `text` (empty when none). */
export function findSensitive(text: string): string[] {
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found.push("card number");
      break;
    }
  }
  return found;
}

/**
 * Removes GPS location from a JPEG's EXIF data without re-encoding the image.
 * Orientation and other camera data are kept so photos still display correctly.
 */
export function removeJpegLocation(input: Uint8Array): { bytes: Uint8Array; removed: boolean } {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return { bytes: input, removed: false };
  const b = new Uint8Array(input);
  let removed = false;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    const length = (b[i + 2] << 8) | b[i + 3];
    const start = i + 4;
    const end = i + 2 + length;
    if (length < 2 || end > b.length) break;
    const isExif = marker === 0xe1 && end - start > 14 && String.fromCharCode(...b.subarray(start, start + 4)) === "Exif";
    if (isExif && clearGps(b, start + 6, end)) removed = true;
    i = end;
  }
  return { bytes: b, removed };
}

const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

function clearGps(b: Uint8Array, tiff: number, end: number): boolean {
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return false;
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) =>
    (little ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > end) return false;
  let cleared = false;
  const count = u16(ifd0);
  for (let k = 0; k < count; k++) {
    const entry = ifd0 + 2 + k * 12;
    if (entry + 12 > end) break;
    if (u16(entry) !== 0x8825) continue; // GPSInfo
    const gps = tiff + u32(entry + 8);
    if (gps + 2 > end) continue;
    const tags = u16(gps);
    for (let j = 0; j < tags; j++) {
      const tag = gps + 2 + j * 12;
      if (tag + 12 > end) break;
      const size = (TYPE_SIZES[u16(tag + 2)] ?? 1) * u32(tag + 4);
      if (size > 4) {
        const at = tiff + u32(tag + 8);
        if (at + size <= end) b.fill(0, at, at + size); // coordinate values stored elsewhere
      }
    }
    b.fill(0, gps, Math.min(end, gps + 2 + tags * 12 + 4)); // leaves an empty GPS directory
    cleared = true;
  }
  return cleared;
}
