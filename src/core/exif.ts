// When a photo was taken, read from its EXIF data (JEITA CP-3451, the EXIF
// standard), with no dependency: only a JPEG's APP1 segment, its TIFF header,
// IFD0 and the Exif IFD are read, and every offset is checked against the end
// of the segment before it is followed. Anything unexpected — a truncated
// file, garbage, a loop of pointers — means "no date", never an exception.

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;
const EXIF_IFD = 0x8769;
const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME_DIGITIZED = 0x9004;
const OFFSET_TIME_ORIGINAL = 0x9011;
const OFFSET_TIME_DIGITIZED = 0x9012;
const ASCII = 2;
/** A JPEG keeps EXIF near its start; nobody needs to read further to find it. */
const MAX_SEGMENTS = 64;
const MAX_ENTRIES = 512;

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const EXIF_OFFSET = /^[+-]\d{2}:\d{2}$/;

/**
 * The moment a JPEG says it was taken, as an ISO 8601 timestamp:
 * `2026-09-15T14:30:00`, with the camera's UTC offset when it recorded one
 * (`2026-09-15T14:30:00+02:00`). DateTimeOriginal first, then
 * DateTimeDigitized. Null when there is no such date, or the bytes aren't a
 * JPEG with EXIF.
 */
export function exifDate(bytes: Uint8Array): string | null {
  try {
    const exif = exifSegment(bytes);
    return exif ? dateIn(bytes, exif.start, exif.end) : null;
  } catch {
    return null;
  }
}

/** The bounds of the TIFF data inside the first Exif APP1 segment. */
function exifSegment(b: Uint8Array): { start: number; end: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) return null;
  let i = 2;
  for (let seen = 0; seen < MAX_SEGMENTS && i + 4 <= b.length; seen++) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes before a marker
    if (i + 3 > b.length) return null;
    const marker = b[i];
    if (marker === SOS || marker === EOI) return null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i++;
      continue; // markers that carry no length
    }
    const length = (b[i + 1] << 8) | b[i + 2];
    const start = i + 3;
    const end = i + 1 + length;
    if (length < 2 || end > b.length) return null;
    if (marker === APP1 && end - start > 14 && b[start] === 0x45 && b[start + 1] === 0x78 && b[start + 2] === 0x69 && b[start + 3] === 0x66 && b[start + 4] === 0 && b[start + 5] === 0) {
      return { start: start + 6, end };
    }
    i = end;
  }
  return null;
}

function dateIn(b: Uint8Array, tiff: number, end: number): string | null {
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return null;
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) =>
    (little ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (tiff + 8 > end || u16(tiff + 2) !== 42) return null;

  /** Entries of the directory at a TIFF offset, as tag → entry position. */
  const directory = (offset: number): Map<number, number> => {
    const tags = new Map<number, number>();
    const at = tiff + offset;
    if (offset < 8 || at + 2 > end) return tags;
    const count = Math.min(u16(at), MAX_ENTRIES);
    for (let k = 0; k < count; k++) {
      const entry = at + 2 + k * 12;
      if (entry + 12 > end) break;
      if (!tags.has(u16(entry))) tags.set(u16(entry), entry);
    }
    return tags;
  };
  const text = (entry: number | undefined): string | null => {
    if (entry === undefined || u16(entry + 2) !== ASCII) return null;
    const count = u32(entry + 4);
    if (count < 1 || count > 64) return null;
    const at = count <= 4 ? entry + 8 : tiff + u32(entry + 8);
    if (at < tiff || at + count > end) return null;
    let s = "";
    for (let k = 0; k < count && b[at + k] !== 0; k++) s += String.fromCharCode(b[at + k]);
    return s.trim();
  };

  const ifd0 = directory(u32(tiff + 4));
  const pointer = ifd0.get(EXIF_IFD);
  if (pointer === undefined) return null;
  const exif = directory(u32(pointer + 8));
  for (const [tag, offsetTag] of [
    [DATE_TIME_ORIGINAL, OFFSET_TIME_ORIGINAL],
    [DATE_TIME_DIGITIZED, OFFSET_TIME_DIGITIZED],
  ]) {
    const iso = isoFrom(text(exif.get(tag)));
    if (!iso) continue;
    const offset = text(exif.get(offsetTag));
    return offset && EXIF_OFFSET.test(offset) && offset !== "+00:00" ? `${iso}${offset}` : offset === "+00:00" ? `${iso}Z` : iso;
  }
  return null;
}

/** `2026:09:15 14:30:00` → `2026-09-15T14:30:00`, if it names a real moment. Cameras write zeros when they don't know. */
function isoFrom(value: string | null): string | null {
  const m = value ? EXIF_DATE.exec(value) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const when = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (y < 1800 || when.getUTCFullYear() !== y || when.getUTCMonth() !== mo - 1 || when.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}
