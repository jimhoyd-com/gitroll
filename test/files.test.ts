// Files on their own: listing everything under .gitroll/files/, unfiled files,
// sidecars (a file's fields, beside it), EXIF dates, and large files kept in
// numbered parts that readers put back together.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exifDate } from "../src/core/exif.ts";
import { groupFiles, linkablePaths, parseSidecar } from "../src/core/files.ts";
import { parsePartSize, partOf, DEFAULT_PART_SIZE, MAX_PART_SIZE } from "../src/core/parts.ts";
import { searchEntries } from "../src/core/search.ts";
import { validateRepo } from "../src/core/validate.ts";
import { mcpTools } from "../src/node/mcp.ts";
import { GitRoll } from "../src/node/repo.ts";
import { attachFile, findFile, joinFile, listFiles, wholeFile } from "../src/node/roll-files.ts";
import { serve } from "../src/node/server.ts";
import { git, tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 20_000 });
}
function json(roll: GitRoll, args: string[]) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function failure(roll: GitRoll, args: string[], code: string) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, code, result.stderr);
  return JSON.parse(result.stderr).error.message as string;
}

/** A Roll whose files split into parts of `partSize`. */
function rollWithParts(partSize = "1KB"): GitRoll {
  const roll = GitRoll.init(tmp(), { name: "Files" });
  fs.appendFileSync(path.join(roll.root, ".gitroll/config.yaml"), `part_size: ${partSize}\n`);
  git(roll.root, "commit", "-qam", "small parts");
  return roll;
}

const write = (dir: string, name: string, data: string | Uint8Array) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
};
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const FILES = ".gitroll/files";

// ── A tiny JPEG with EXIF, built by hand ────────────────────────────────────

/**
 * SOI, an APP1 Exif segment and EOI. IFD0 holds only the pointer to the Exif
 * IFD, which holds DateTimeOriginal and, optionally, OffsetTimeOriginal.
 */
function jpegWithExif(date: string, opts: { little?: boolean; offset?: string } = {}): Uint8Array {
  const little = opts.little ?? true;
  const tiff: number[] = [];
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const ascii = (s: string) => [...Buffer.from(`${s}\0`, "latin1")];
  const exifEntries = opts.offset ? 2 : 1;
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 12 + 4;
  const dataAt = exifIfd + 2 + exifEntries * 12 + 4;
  const dateBytes = ascii(date);
  const offsetBytes = opts.offset ? ascii(opts.offset) : [];
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0));
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfd), ...u32(0));
  tiff.push(...u16(exifEntries), ...u16(0x9003), ...u16(2), ...u32(dateBytes.length), ...u32(dataAt));
  if (opts.offset) tiff.push(...u16(0x9011), ...u16(2), ...u32(offsetBytes.length), ...u32(dataAt + dateBytes.length));
  tiff.push(...u32(0), ...dateBytes, ...offsetBytes);
  const payload = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xd9]);
}

test("EXIF DateTimeOriginal is read from a handmade JPEG, either byte order", () => {
  assert.equal(exifDate(jpegWithExif("2026:09:15 14:30:05")), "2026-09-15T14:30:05");
  assert.equal(exifDate(jpegWithExif("2026:09:15 14:30:05", { little: false })), "2026-09-15T14:30:05");
  assert.equal(exifDate(jpegWithExif("2026:09:15 14:30:05", { offset: "+02:00" })), "2026-09-15T14:30:05+02:00");
  // A JFIF APP0 segment before the EXIF one is skipped over.
  const jfif = Uint8Array.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const plain = jpegWithExif("2025:01:02 03:04:05");
  assert.equal(exifDate(Uint8Array.from([...plain.subarray(0, 2), ...jfif, ...plain.subarray(2)])), "2025-01-02T03:04:05");
});

test("garbage, truncation and impossible dates give no EXIF date and never throw", () => {
  const good = jpegWithExif("2026:09:15 14:30:05");
  assert.equal(exifDate(new Uint8Array()), null);
  assert.equal(exifDate(Uint8Array.from([0xff, 0xd8])), null);
  assert.equal(exifDate(Buffer.from("not a jpeg at all")), null);
  assert.equal(exifDate(jpegWithExif("0000:00:00 00:00:00")), null, "cameras write zeros when they don't know");
  assert.equal(exifDate(jpegWithExif("2026:02:30 10:00:00")), null);
  // Cut anywhere inside the EXIF segment (the last two bytes are the end-of-image marker after it).
  for (let cut = 0; cut < good.length - 2; cut++) assert.equal(exifDate(good.subarray(0, cut)), null, `cut at ${cut}`);
  for (let i = 0; i < 300; i++) {
    const noise = randomBytes(64 + (i % 200));
    noise[0] = 0xff;
    noise[1] = 0xd8;
    assert.doesNotThrow(() => exifDate(noise));
    // Flip bytes of a real EXIF block: whatever comes back is a date or nothing.
    const flipped = Uint8Array.from(good);
    flipped[4 + (i % (good.length - 6))] ^= 0xff;
    const got = exifDate(flipped);
    assert.ok(got === null || /^\d{4}-\d{2}-\d{2}T/.test(got), String(got));
  }
  // A pointer to the Exif IFD that points back at IFD0 isn't followed forever.
  const loop = Uint8Array.from(good);
  loop[6 + 6 + 8 + 2 + 8] = 8; // the pointer's value, little-endian
  loop[6 + 6 + 8 + 2 + 9] = 0;
  assert.equal(exifDate(loop), null);
});

// ── Grouping, sidecars and search ──────────────────────────────────────────

test("files are grouped by the name links use: whole files, parts, sidecars", () => {
  const groups = groupFiles([
    `${FILES}/receipt.pdf`,
    `${FILES}/passport.pdf`,
    `${FILES}/passport.pdf.md`,
    `${FILES}/walk.mp4.001`,
    `${FILES}/walk.mp4.002`,
    `${FILES}/walk.mp4.md`,
    `${FILES}/minutes.md`,
    `${FILES}/later.jpg.md`,
    `${FILES}/.gitkeep`,
    ".gitroll/events/2026-01-01-x.md",
  ]);
  const by = Object.fromEntries(groups.map((g) => [g.path.slice(FILES.length + 1), g]));
  assert.deepEqual(Object.keys(by).sort(), ["later.jpg", "minutes.md", "passport.pdf", "receipt.pdf", "walk.mp4"]);
  assert.equal(by["passport.pdf"].sidecar, `${FILES}/passport.pdf.md`);
  assert.deepEqual(by["walk.mp4"].parts, [`${FILES}/walk.mp4.001`, `${FILES}/walk.mp4.002`]);
  assert.equal(by["walk.mp4"].whole, false);
  assert.equal(by["minutes.md"].sidecar, null, "a Markdown file kept as a file is just a file");
  assert.equal(by["later.jpg"].whole, false, "a sidecar can arrive before its file");
  assert.ok(linkablePaths([`${FILES}/walk.mp4.001`]).has(`${FILES}/walk.mp4`));
  assert.deepEqual(partOf("a/b.mp4.012"), { base: "a/b.mp4", n: 12 });
  assert.equal(partOf("a/b.mp4.12"), null);
  assert.equal(partOf("a/b.mp4.abc"), null);
});

test("part_size reads megabytes or a size with a unit, within GitHub's limit", () => {
  assert.equal(parsePartSize(undefined), DEFAULT_PART_SIZE);
  assert.equal(parsePartSize(10), 10 * 1024 * 1024);
  assert.equal(parsePartSize("512 KB"), 512 * 1024);
  assert.equal(parsePartSize("1kb"), 1024);
  assert.equal(parsePartSize("2GB"), MAX_PART_SIZE);
  assert.equal(parsePartSize("lots"), DEFAULT_PART_SIZE);
  assert.equal(parsePartSize(-3), DEFAULT_PART_SIZE);
});

test("a sidecar is its file's record: Dublin Core title and subject, searchable as is:file", () => {
  const passport = parseSidecar(`${FILES}/passport.pdf.md`, "---\ntitle: Passport\ncreator: State Dept\nsubject: [travel, ID]\nexpires: 2030-05-01\n---\n\nScanned at the library.\n");
  assert.equal(passport.title, "Passport");
  assert.deepEqual(passport.tags.sort(), ["id", "travel"]);
  assert.equal(passport.attachments[0].path, `${FILES}/passport.pdf`);
  const bare = parseSidecar(`${FILES}/walk.mp4.md`, "---\nparts: 2\n---\n\nThe first line of a description isn't a title.\n");
  assert.equal(bare.title, "walk.mp4", "the file's own name, not a line of prose");
  const headed = parseSidecar(`${FILES}/x.png.md`, "# Front of the house\n");
  assert.equal(headed.title, "Front of the house");
  const events = [{ ...passport, path: ".gitroll/events/2026-01-01-passport.md", id: "e", attachments: [] }];
  const all = [...events, passport, bare];
  assert.deepEqual(searchEntries(all, "is:file").map((e) => e.path), [passport.path, bare.path]);
  assert.deepEqual(searchEntries(all, "is:file expires<2031").map((e) => e.path), [passport.path]);
  assert.deepEqual(searchEntries(all, "creator:state").map((e) => e.path), [".gitroll/events/2026-01-01-passport.md", passport.path]);
  assert.deepEqual(searchEntries(all, "library is:file").map((e) => e.path), [passport.path]);
  assert.deepEqual(searchEntries(all, "is:file has:pdf").map((e) => e.path), [passport.path]);
});

test("gitroll files lists every file with what links to it, and which are unfiled", () => {
  const roll = GitRoll.init(tmp(), { name: "Files" });
  const dir = tmp();
  roll.save({ text: "AC serviced" }, [{ name: "ac-receipt.pdf", type: "application/pdf", data: Buffer.from("%PDF receipt") }]);
  fs.mkdirSync(path.join(roll.root, FILES, "scans"), { recursive: true });
  fs.writeFileSync(path.join(roll.root, FILES, "scans/passport.pdf"), "%PDF passport");
  fs.writeFileSync(path.join(roll.root, FILES, "scans/passport.pdf.md"), "---\ntitle: Passport\nexpires: 2030-05-01\n---\n");
  roll.saveNote({ title: "Documents", text: "[Passport sidecar](../files/scans/passport.pdf.md)" });
  attachFile(roll, write(dir, "Old Photo.png", "png bytes"));

  const files = json(roll, ["files"]);
  const by = Object.fromEntries(files.map((f: { path: string }) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), [`${FILES}/ac-receipt.pdf`, `${FILES}/old-photo.png`, `${FILES}/scans/passport.pdf`]);
  assert.equal(by[`${FILES}/ac-receipt.pdf`].unfiled, false);
  assert.match(by[`${FILES}/ac-receipt.pdf`].linkedFrom[0], /^\.gitroll\/events\/.*ac-serviced\.md$/);
  assert.equal(by[`${FILES}/scans/passport.pdf`].unfiled, false, "linking the sidecar counts");
  assert.equal(by[`${FILES}/scans/passport.pdf`].title, "Passport");
  assert.equal(by[`${FILES}/old-photo.png`].unfiled, true);
  assert.equal(by[`${FILES}/old-photo.png`].size, 9);
  assert.deepEqual(json(roll, ["files", "--unfiled"]).map((f: { path: string }) => f.path), [`${FILES}/old-photo.png`]);
  assert.deepEqual(json(roll, ["files", "expires>=2030"]).map((f: { path: string }) => f.path), [`${FILES}/scans/passport.pdf`]);
  assert.deepEqual(json(roll, ["find", "is:file"]).map((e: { path: string }) => e.path), [`${FILES}/scans/passport.pdf.md`]);
  assert.match(run(roll, ["files"]).stdout, /old-photo\.png[\s\S]*unfiled/);
});

test("attach copies a file under a free name, links it, and writes a sidecar with --field", () => {
  const roll = GitRoll.init(tmp(), { name: "Files" });
  const dir = tmp();
  roll.saveNote({ title: "Documents" });
  fs.mkdirSync(path.join(roll.root, FILES), { recursive: true });
  fs.writeFileSync(path.join(roll.root, FILES, "scan.pdf"), "already here");
  const result = json(roll, ["attach", write(dir, "scan.pdf", "%PDF new"), "--to", "documents", "--field", "title=Lease", "--field", "expires=2027-01-31"]);
  assert.equal(result.path, `${FILES}/scan-2.pdf`, "nothing is overwritten");
  assert.equal(fs.readFileSync(path.join(roll.root, FILES, "scan.pdf"), "utf8"), "already here");
  assert.equal(result.sidecar, `${FILES}/scan-2.pdf.md`);
  assert.equal(result.sha256, sha(Buffer.from("%PDF new")));
  assert.deepEqual(result.linkedFrom, [".gitroll/notes/documents.md"]);
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/notes/documents.md"), "utf8"), /\[scan\.pdf\]\(\.\.\/files\/scan-2\.pdf\)/);
  const sidecar = fs.readFileSync(path.join(roll.root, result.sidecar), "utf8");
  assert.match(sidecar, /title: Lease/);
  assert.match(sidecar, /expires: 2027-01-31/);
  assert.equal(git(roll.root, "status", "--porcelain").trim().split("\n").filter((l) => l.includes(".gitroll/files/scan.pdf")).length, 1, "only GitRoll's own writes were committed");
  assert.match(git(roll.root, "log", "-1", "--format=%s"), /^attach: scan-2\.pdf/);
  failure(roll, ["attach", dir], "USER_ERROR");
  failure(roll, ["attach", path.join(dir, "nope.pdf")], "NOT_FOUND");
  failure(roll, ["attach", write(dir, "x.txt", "x"), "--field", "date=someday"], "USER_ERROR");
  assert.ok(!fs.existsSync(path.join(roll.root, FILES, "x.txt")), "a sidecar that can't be read is refused before the file is copied");
});

test("a sidecar created for a JPEG takes its date from EXIF, by attach or by set", () => {
  const roll = GitRoll.init(tmp(), { name: "Photos" });
  const dir = tmp();
  const photo = jpegWithExif("2024:07:04 18:22:10");
  const attached = json(roll, ["attach", write(dir, "fireworks.jpg", photo), "--field", "title=Fireworks"]);
  assert.match(fs.readFileSync(path.join(roll.root, attached.sidecar), "utf8"), /date: 2024-07-04T18:22:10/);
  const given = json(roll, ["attach", write(dir, "dated.jpg", photo), "--field", "date=2020-01-01"]);
  assert.match(fs.readFileSync(path.join(roll.root, given.sidecar), "utf8"), /date: 2020-01-01/);
  const plain = json(roll, ["attach", write(dir, "plain.jpg", photo)]);
  assert.equal(plain.sidecar, null, "no fields, no parts: no sidecar");
  const set = json(roll, ["set", "files/plain.jpg", "subject=[holiday]"]);
  assert.equal(set.changed, true);
  assert.equal(set.entry.path, `${FILES}/plain.jpg.md`);
  assert.equal(set.entry.date, "2024-07-04T18:22:10");
  assert.deepEqual(set.entry.tags, ["holiday"]);
  // set works on an existing sidecar too, and keeps what it doesn't touch.
  const again = json(roll, ["set", "fireworks.jpg", "creator=Ana", "--expect", sha(fs.readFileSync(path.join(roll.root, attached.sidecar)))]);
  assert.equal(again.entry.meta.title, "Fireworks");
  assert.equal(again.entry.meta.creator, "Ana");
  failure(roll, ["set", "files/fireworks.jpg", "creator=Bo", "--expect", "0".repeat(64)], "CONFLICT");
  assert.equal(json(roll, ["find", "creator:ana"])[0].path, `${FILES}/fireworks.jpg.md`);
  assert.equal(json(roll, ["check"]).errors.length, 0);
});

// ── Parts ──────────────────────────────────────────────────────────────────

test("a large file is split into numbered parts with a sha256 sidecar, and joins back byte for byte", () => {
  const roll = rollWithParts("1KB");
  const dir = tmp();
  const data = randomBytes(2500);
  const result = json(roll, ["attach", write(dir, "House Walkthrough.mp4", data)]);
  assert.equal(result.path, `${FILES}/house-walkthrough.mp4`);
  assert.equal(result.parts, 3);
  const names = fs.readdirSync(path.join(roll.root, FILES)).sort();
  assert.deepEqual(names, ["house-walkthrough.mp4.001", "house-walkthrough.mp4.002", "house-walkthrough.mp4.003", "house-walkthrough.mp4.md"]);
  assert.equal(fs.statSync(path.join(roll.root, FILES, "house-walkthrough.mp4.001")).size, 1024);
  const sidecar = fs.readFileSync(path.join(roll.root, FILES, "house-walkthrough.mp4.md"), "utf8");
  assert.match(sidecar, /^---\nparts: 3\nsize: 2500\nsha256: "?[0-9a-f]{64}"?\n---/);
  assert.ok(sidecar.includes(sha(data)));

  // `cat name.0* > name` is all it takes without GitRoll: the parts, in name order.
  const catted = Buffer.concat(names.filter((n) => /\.\d{3}$/.test(n)).map((n) => fs.readFileSync(path.join(roll.root, FILES, n))));
  assert.deepEqual(catted, data);

  const out = path.join(dir, "joined.mp4");
  const joined = json(roll, ["join", "house-walkthrough.mp4", "--out", out]);
  assert.deepEqual(fs.readFileSync(out), data);
  assert.equal(joined.verified, true);
  assert.equal(joined.sha256, sha(data));
  assert.match(failure(roll, ["join", "house-walkthrough.mp4", "--out", out], "USER_ERROR"), /already exists/);
  failure(roll, ["join", "house-walkthrough.mp4", "extra", "--out", path.join(dir, "y")], "INVALID_ARGUMENT");

  // An event links to the whole name, and that link resolves.
  roll.save({ text: `Walkthrough\n\n[Video](../files/house-walkthrough.mp4)` });
  const listed = json(roll, ["files"]).find((f: { path: string }) => f.path === result.path);
  assert.equal(listed.size, 2500);
  assert.equal(listed.parts, 3);
  assert.equal(listed.unfiled, false);
  const check = json(roll, ["check"]);
  assert.deepEqual(check.problems, []);
  assert.equal(git(roll.root, "status", "--porcelain").trim(), "", "parts and sidecar are committed together");
});

test("check reports a missing part and a sha256 that doesn't match", () => {
  const roll = rollWithParts("1KB");
  const dir = tmp();
  const { path: rel } = attachFile(roll, write(dir, "big.bin", randomBytes(3000)));
  const part2 = path.join(roll.root, `${rel}.002`);
  const original = fs.readFileSync(part2);

  const tampered = Buffer.from(original);
  tampered[10] ^= 0xff;
  fs.writeFileSync(part2, tampered);
  let result = run(roll, ["check", "--json"]);
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).errors.some((p: { path: string; error: string }) => p.path === rel && /sha256/.test(p.error)), result.stdout);
  assert.match(failure(roll, ["join", "big.bin", "--out", path.join(dir, "bad.bin")], "USER_ERROR"), /sha256/);
  assert.ok(!fs.existsSync(path.join(dir, "bad.bin")), "nothing is left behind when the hash is wrong");

  fs.rmSync(part2);
  result = run(roll, ["check", "--json"]);
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).errors.some((p: { path: string; error: string }) => p.path === rel && /missing part 002/.test(p.error)), result.stdout);
  assert.throws(() => wholeFile(roll, rel), /missing parts/);

  // Parts beyond what the sidecar lists are worth a warning; a missing sidecar too.
  fs.writeFileSync(part2, original);
  fs.writeFileSync(path.join(roll.root, `${rel}.004`), "extra");
  assert.ok(json(roll, ["check"]).warnings.some((p: { error: string }) => /beyond the 3/.test(p.error)));
  fs.rmSync(path.join(roll.root, `${rel}.004`));
  fs.rmSync(path.join(roll.root, `${rel}.md`));
  assert.ok(json(roll, ["check"]).warnings.some((p: { error: string }) => /no sidecar/.test(p.error)));
});

test("the core validator checks parts from paths alone when it can't read bytes", () => {
  const problems = validateRepo({
    paths: [".gitroll/config.yaml", `${FILES}/a.mp4.001`, `${FILES}/a.mp4.003`, `${FILES}/a.mp4.md`, ".gitroll/events/2026-01-01-a.md"],
    read: (p) => (p.endsWith("config.yaml") ? "template_version: 1\n" : p.endsWith(".md") && p.includes("files") ? "---\nparts: 3\n---\n" : "# A\n\n[Video](../files/a.mp4)\n"),
  });
  assert.deepEqual(problems.map((p) => p.error), ["is missing part 002, so it can't be put back together"]);
});

test("the web server streams a file kept in parts as one file", async () => {
  const roll = rollWithParts("1KB");
  const dir = tmp();
  const data = randomBytes(5000);
  const { path: rel } = attachFile(roll, write(dir, "clip.mp4", data));
  const web = tmp();
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>GitRoll</title>");
  const running = await serve(roll, { port: 0, webDir: web });
  try {
    const signIn = await fetch(running.url, { redirect: "manual" });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
    const base = new URL(running.url).origin;
    const res = await fetch(`${base}/attachments/${rel.split("/").map(encodeURIComponent).join("/")}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), "5000");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), data);
    const anonymous = await fetch(`${base}/attachments/${rel}`);
    assert.equal(anonymous.status, 401);

    // Escapes are refused, encoded or not, and a part behind a symbolic link isn't served.
    const port = new URL(running.url).port;
    const raw = (p: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: p, headers: { Cookie: cookie } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        }).on("error", reject);
      });
    assert.equal(await raw("/attachments/..%2F..%2F..%2Fetc%2Fpasswd"), 404);
    assert.equal(await raw("/attachments/.gitroll/files/..%2F..%2F..%2Foutside.bin"), 404);
    const outside = write(tmp(), "secret.bin", "secret");
    fs.symlinkSync(outside, path.join(roll.root, FILES, "linked.bin.001"));
    assert.equal(await raw("/attachments/.gitroll/files/linked.bin"), 404);
  } finally {
    running.server.close();
  }
});

test("file paths never escape the Roll", () => {
  const roll = rollWithParts("1KB");
  const dir = tmp();
  attachFile(roll, write(dir, "a.bin", randomBytes(2000)));
  const outside = path.join(path.dirname(roll.root), `outside-${randomBytes(4).toString("hex")}.bin`);
  fs.writeFileSync(outside, "outside");
  fs.writeFileSync(`${outside}.001`, "outside part");
  const name = path.basename(outside);
  for (const target of [`../${name}`, `../../${name}`, "/etc/passwd", `${FILES}/../../../${name}`]) {
    assert.equal(wholeFile(roll, target), null, target);
    assert.equal(findFile(roll, target), null, target);
  }
  assert.throws(() => joinFile(roll, `../${name}`, path.join(dir, "o")), /No file/);
  failure(roll, ["set", `../${name}.md`, "title=x"], "NOT_FOUND");
  assert.ok(!fs.existsSync(`${outside}.md`));
  assert.deepEqual(listFiles(roll).map((f) => f.path), [`${FILES}/a.bin`]);
  // An attachment named to climb out lands inside files/, under a safe name.
  const climbing = write(dir, "..%2F..%2Fevil.txt", "x");
  assert.match(attachFile(roll, climbing).path, /^\.gitroll\/files\/[^/]+\.txt$/);
});

test("attach and files are tools over MCP, attach reads only the file it is given, and --open isn't offered", () => {
  const tools = mcpTools();
  const attach = tools.find((t) => t.name === "gitroll_attach")!;
  assert.ok(attach);
  assert.match(attach.description, /reads only the one file on this computer that <path> names/);
  assert.match(attach.inputSchema.properties.path.description ?? "", /Only that file is read/);
  assert.deepEqual(attach.inputSchema.required, ["path"]);
  const files = tools.find((t) => t.name === "gitroll_files")!;
  assert.ok(files.inputSchema.properties.unfiled);
  assert.equal(files.inputSchema.properties.open, undefined, "opening an app needs a person in front of it");
  assert.ok(tools.find((t) => t.name === "gitroll_join")!.inputSchema.properties.out);
  const roll = GitRoll.init(tmp(), { name: "Files" });
  failure(roll, ["files", "--open", "x.pdf"], "INTERACTION_REQUIRED");
});
