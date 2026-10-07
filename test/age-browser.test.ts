// The browser's age crypto (src/web/age-crypto.ts) against Node's: whatever one
// seals the other opens, with the X25519 identities `gitroll key new` makes.
// Both of the browser backend's X25519 paths are covered: WebCrypto's, and
// @noble/curves for browsers that lack it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgeError, ScryptIdentity, ScryptRecipient, X25519Identity, armor, decrypt, decryptAny, encrypt } from "../src/core/age/format.ts";
import { fromUtf8, utf8 } from "../src/core/age/bytes.ts";
import type { AgeCrypto } from "../src/core/age/crypto.ts";
import { nodeAgeCrypto } from "../src/node/age-crypto.ts";
import { browserAgeCrypto } from "../src/web/age-crypto.ts";

const backends: [string, AgeCrypto][] = [
  ["WebCrypto X25519", browserAgeCrypto({ x25519: "webcrypto" })],
  ["@noble/curves X25519", browserAgeCrypto({ x25519: "noble" })],
  ["auto", browserAgeCrypto()],
];

// Large enough for three payload chunks, so chunk nonces and the last-chunk flag are exercised.
const big = new Uint8Array(64 * 1024 * 2 + 1234).map((_, i) => (i * 31) % 251);

for (const [name, browser] of backends) {
  test(`browser (${name}) and Node agree on public keys`, async () => {
    const id = await X25519Identity.generate(nodeAgeCrypto);
    assert.equal((await id.recipient(browser)).toString(), (await id.recipient(nodeAgeCrypto)).toString());
  });

  test(`browser (${name}) opens what Node sealed, and Node opens what the browser sealed`, async () => {
    const id = await X25519Identity.generate(nodeAgeCrypto);
    const parsed = X25519Identity.parse(id.toString());
    const to = await parsed.recipient(nodeAgeCrypto);
    for (const plain of [utf8("Gate code: 4417"), new Uint8Array(0), big]) {
      const fromNode = await encrypt(plain, [to], nodeAgeCrypto);
      assert.deepEqual(await decrypt(fromNode, [parsed], browser), plain);
      const fromBrowser = await encrypt(plain, [to], browser);
      assert.deepEqual(await decrypt(fromBrowser, [parsed], nodeAgeCrypto), plain);
    }
    // Armored, as a sealed block holds it.
    const armored = armor(await encrypt(utf8("Sealed **Markdown**"), [to], nodeAgeCrypto));
    assert.equal(fromUtf8(await decryptAny(armored, [parsed], browser)), "Sealed **Markdown**");
  });

  test(`browser (${name}) refuses a file for another key, and a tampered one`, async () => {
    const mine = await X25519Identity.generate(browser);
    const theirs = await X25519Identity.generate(browser);
    const file = await encrypt(utf8("not yours"), [await theirs.recipient(nodeAgeCrypto)], nodeAgeCrypto);
    await assert.rejects(decrypt(file, [mine], browser), AgeError);
    const tampered = file.slice();
    tampered[tampered.length - 1] ^= 1;
    await assert.rejects(decrypt(tampered, [theirs], browser), AgeError);
  });
}

test("browser and Node agree on scrypt (passphrase) files", async () => {
  const browser = browserAgeCrypto();
  const fromNode = await encrypt(utf8("by passphrase"), [new ScryptRecipient("correct horse", 10)], nodeAgeCrypto);
  assert.equal(fromUtf8(await decrypt(fromNode, [new ScryptIdentity("correct horse")], browser)), "by passphrase");
  const fromBrowser = await encrypt(utf8("and back"), [new ScryptRecipient("correct horse", 10)], browser);
  assert.equal(fromUtf8(await decrypt(fromBrowser, [new ScryptIdentity("correct horse")], nodeAgeCrypto)), "and back");
});

test("the browser backend refuses a low-order point, like Node's", async () => {
  const browser = browserAgeCrypto({ x25519: "noble" });
  const scalar = new Uint8Array(32).fill(3);
  const zero = new Uint8Array(32);
  await assert.rejects(Promise.resolve().then(() => browser.x25519(scalar, zero)));
});
