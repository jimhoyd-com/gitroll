// Bookmarks: web pages kept as records in notes/bookmarks/ with a url, tags,
// a description and the day each was added; out to and in from the Netscape
// bookmark file browsers use, each page once.

import "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bookmarks, findBookmark, htmlText, parseNetscapeBookmarks, planBookmarkImport, titleFromUrl, toNetscapeBookmarks, urlKey, webUrl } from "../src/core/bookmarks.ts";
import { parseEntry } from "../src/core/entry.ts";
import * as core from "../src/core/index.ts";
import { mcpTools } from "../src/node/mcp.ts";
import { GitRoll } from "../src/node/repo.ts";
import { tmp } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/node/cli.ts", import.meta.url));
function run(roll: GitRoll, args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args, "-C", roll.root], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
}
function json(roll: GitRoll, args: string[]) {
  const result = run(roll, [...args, "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
const doc = (p: string, front: string, body = "# Untitled") => parseEntry(p, `---\n${front}\n---\n\n${body}\n`);

const spec = doc(".gitroll/notes/bookmarks/vcard.md", "url: https://www.rfc-editor.org/rfc/rfc6350\ntags: [standards, contacts]\ndescription: vCard 4.0\nadded: 2026-09-01", "# vCard Format Specification");
const recipe = doc(".gitroll/notes/bookmarks/bread.md", "url: https://example.com/bread/\ntags: [cooking]\nadded: 2026-10-01", "# Bread");
const again = doc(".gitroll/notes/bookmarks/bread-2.md", "url: HTTPS://Example.com/bread#method", "# Bread again");
const pinned = doc(".gitroll/notes/bookmarks/docs.md", "url: https://nodejs.org/api/\npinned: true\ntags: [standards]", "# Node docs");
const noUrl = doc(".gitroll/notes/bookmarks/someday.md", "tags: [reading]", "# Something to find");
const read = doc(".gitroll/events/2026/2026-09-03-read.md", "", "# Read up on vCard\n\nThe [spec](../../notes/bookmarks/vcard.md).");

test("addresses: only http and https, and the same page however it is written", () => {
  assert.equal(webUrl("javascript:alert(1)"), null);
  assert.equal(webUrl("ftp://example.com/x"), null);
  assert.equal(webUrl("https://"), null);
  assert.equal(webUrl("example.com"), null);
  assert.ok(webUrl(" https://example.com "));
  assert.equal(urlKey("HTTPS://Example.COM:443/Docs/#intro"), "https://example.com/Docs", "the path's case is the page's own");
  assert.equal(urlKey("https://example.com/docs/"), urlKey("https://example.com/docs"));
  assert.notEqual(urlKey("https://example.com/item?id=1"), urlKey("https://example.com/item?id=2"), "the query says which page");
  assert.notEqual(urlKey("http://example.com/"), urlKey("https://example.com/"));
  assert.equal(titleFromUrl("https://www.example.com/caf%C3%A9/menu/"), "example.com/café/menu");
  assert.equal(titleFromUrl("https://example.com/%E0%A4%A"), "example.com/%E0%A4%A", "a broken escape is kept as written");
});

test("bookmarks: pinned first, then newest added, with tags, duplicates and what links to each", () => {
  const view = bookmarks([spec, recipe, again, pinned, noUrl], [spec, recipe, again, pinned, noUrl, read]);
  assert.equal(view.collection, "bookmarks");
  assert.deepEqual(view.bookmarks.map((b) => b.title), ["Node docs", "Bread", "vCard Format Specification", "Bread again", "Something to find"]);
  const v = view.bookmarks[2];
  assert.deepEqual(
    { url: v.url, site: v.site, tags: v.tags, description: v.description, added: v.added, pinned: v.pinned },
    { url: "https://www.rfc-editor.org/rfc/rfc6350", site: "rfc-editor.org", tags: ["standards", "contacts"], description: "vCard 4.0", added: "2026-09-01", pinned: false },
  );
  assert.deepEqual(v.linkedFrom, [{ path: read.path, title: "Read up on vCard", date: read.date }]);
  assert.equal(view.bookmarks[4].url, null);
  assert.deepEqual(view.tags, [
    { tag: "standards", count: 2 },
    { tag: "contacts", count: 1 },
    { tag: "cooking", count: 1 },
    { tag: "reading", count: 1 },
  ]);
  assert.deepEqual(view.duplicates, [{ url: "https://example.com/bread", paths: [again.path, recipe.path] }]);
  assert.equal(findBookmark([spec, recipe], "https://example.com/bread")?.path, recipe.path);
  assert.equal(findBookmark([spec, recipe], "https://example.com/rye"), null);
  assert.equal(typeof core.bookmarks, "function");
  assert.equal(core.BOOKMARKS_COLLECTION, "bookmarks");
});

const EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1700000000" ICON="data:image/png;base64,AAAA">Example &amp; Co</A>
        <DT><H3>Work Stuff</H3>
        <DL><p>
            <DT><A HREF="https://github.com/jimhoyd-com/gitroll" TAGS="git,Code">gitroll</A>
            <DD>Structured memory &lt;in Git&gt; &#x2014; for agents
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
            <DT><A HREF='https://example.org/single' add_date=1700000000000>Single quotes, milliseconds</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://EXAMPLE.com#top">Example again</A>
    <DT><A HREF="https://example.net/untitled"></A>
</DL><p>
`;

test("a Netscape bookmark file: folders as tags, descriptions, dates, and what isn't a web page", () => {
  const { bookmarks: found, problems } = parseNetscapeBookmarks(EXPORT);
  assert.deepEqual(
    found.map((b) => [b.item, b.title, b.url, b.tags, b.description, b.added]),
    [
      [1, "Example & Co", "https://example.com/", [], null, "2023-11-14"],
      [2, "gitroll", "https://github.com/jimhoyd-com/gitroll", ["work-stuff", "git", "code"], "Structured memory <in Git> — for agents", null],
      [4, "Single quotes, milliseconds", "https://example.org/single", ["work-stuff"], null, "2023-11-14"],
      [5, "Example again", "https://EXAMPLE.com#top", [], null, null],
      [6, "example.net/untitled", "https://example.net/untitled", [], null, null],
    ],
  );
  assert.deepEqual(problems, [{ item: 3, message: "Bookmarklet isn't a web page (javascript:alert(1)), so it was left out." }]);
  assert.equal(htmlText("a &amp;amp; b &#0; &#xD800; &bogus; <b>c</b>"), "a &amp; b &#0; &#xD800; &bogus; c");

  const plan = planBookmarkImport(EXPORT, [recipe]);
  assert.deepEqual(plan.create.map((b) => b.title), ["Example & Co", "gitroll", "Single quotes, milliseconds", "example.net/untitled"]);
  assert.deepEqual(plan.skip.map((b) => b.title), ["Example again"], "the same page as Example & Co, earlier in the file");
  assert.deepEqual(planBookmarkImport(EXPORT, [doc(".gitroll/notes/bookmarks/x.md", "url: https://example.com")]).skip.map((b) => b.title), ["Example & Co", "Example again"]);
});

test("bookmarks go out as a Netscape file that reads back the same", () => {
  const view = bookmarks([spec, recipe, noUrl, doc(".gitroll/notes/bookmarks/q.md", 'url: "https://example.com/?a=1&b=\\"2\\""\ndescription: "Two\\nlines <b>"', '# Fish & "chips" <3')]);
  const html = toNetscapeBookmarks(view.bookmarks);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>\n/);
  assert.match(html, /<DT><A HREF="https:\/\/www\.rfc-editor\.org\/rfc\/rfc6350" ADD_DATE="1788220800" TAGS="standards,contacts">vCard Format Specification<\/A>\n {4}<DD>vCard 4\.0\n/);
  assert.match(html, /HREF="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;">Fish &amp; &quot;chips&quot; &lt;3<\/A>\n {4}<DD>Two lines &lt;b&gt;\n/);
  assert.ok(!html.includes("Something to find"), "a bookmark without an address is left out");
  const back = parseNetscapeBookmarks(html).bookmarks;
  assert.deepEqual(
    back.map((b) => [b.title, b.url, b.tags, b.description, b.added]),
    view.bookmarks.filter((b) => b.url).map((b) => [b.title, b.url, b.tags, b.description?.replace(/\s+/g, " ") ?? null, b.added]),
  );
});

test("reading a bookmark file takes time in proportion to its size, whatever is in it", () => {
  // Unclosed tags, attributes without quotes, endless DDs: each could make a
  // careless reader go back over the file once per tag.
  for (const piece of ["<DT><A HREF=", "<DD>x", "<H3>", "<a href='https://e.com/", "<DL><p>", "&#x", "<A HREF=\"https://e.com\" TAGS=\"" + "a,".repeat(20)]) {
    const big = piece.repeat(Math.ceil(400_000 / piece.length));
    const started = performance.now();
    parseNetscapeBookmarks(big);
    assert.ok(performance.now() - started < 2_000, `${JSON.stringify(piece)} repeated took too long`);
  }
});

test("gitroll bookmark, bookmarks and import bookmarks, with --json, --html and --collection", () => {
  const roll = GitRoll.init(tmp(), { name: "Bookmarks" });
  const empty = run(roll, ["bookmarks"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No bookmarks in bookmarks yet\. Add one with: gitroll bookmark https:\/\/example\.com/);

  const added = json(roll, ["bookmark", "https://www.rfc-editor.org/rfc/rfc6350", "vCard", "Format", "--tag", "standards,Contacts", "--tag", "reading", "--description", "vCard 4.0"]);
  assert.equal(added.existing, false);
  assert.equal(added.entry.path, ".gitroll/notes/bookmarks/vcard-format.md");
  const file = fs.readFileSync(path.join(roll.root, added.entry.path), "utf8");
  assert.match(file, /^url: https:\/\/www\.rfc-editor\.org\/rfc\/rfc6350$/m);
  assert.match(file, /^tags:\n {2}- standards\n {2}- contacts\n {2}- reading$/m);
  assert.match(file, /^description: vCard 4\.0$/m);
  assert.match(file, /^added: \d{4}-\d{2}-\d{2}$/m);
  assert.match(file, /\n# vCard Format\n/);
  assert.match(roll.git(["log", "-1", "--format=%s"]), /^add: vCard Format/);

  const commits = roll.git(["rev-list", "--count", "HEAD"]).trim();
  const twice = json(roll, ["bookmark", "https://WWW.rfc-editor.org/rfc/rfc6350/#section-6"]);
  assert.equal(twice.existing, true);
  assert.equal(twice.entry.path, added.entry.path);
  assert.equal(roll.git(["rev-list", "--count", "HEAD"]).trim(), commits, "nothing written");
  assert.match(run(roll, ["bookmark", "https://www.rfc-editor.org/rfc/rfc6350"]).stdout, /^Already bookmarked: vCard Format/);

  const untitled = json(roll, ["bookmark", "https://nodejs.org/api/fs.html"]);
  assert.equal(untitled.entry.title, "nodejs.org/api/fs.html");
  for (const bad of ["javascript:alert(1)", "example.com"]) {
    const refused = run(roll, ["bookmark", bad, "--json"]);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stderr).error.code, "INVALID_ARGUMENT");
  }

  const view = json(roll, ["bookmarks"]);
  assert.deepEqual(view.bookmarks.map((b: { title: string }) => b.title).sort(), ["nodejs.org/api/fs.html", "vCard Format"]);
  assert.deepEqual(json(roll, ["bookmarks", "tag:standards"]).bookmarks.map((b: { title: string }) => b.title), ["vCard Format"]);
  assert.match(run(roll, ["bookmarks", "tag:standards"]).stdout, /^vCard Format {2}https:\/\/www\.rfc-editor\.org\/rfc\/rfc6350 {2}#standards #contacts #reading {2}added \d{4}-\d{2}-\d{2}\n$/);
  const html = run(roll, ["bookmarks", "--html"]);
  assert.match(html.stdout, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>\n[\s\S]*TAGS="standards,contacts,reading">vCard Format<\/A>/);
  assert.match(json(roll, ["bookmarks", "--html"]).html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);

  const exported = path.join(tmp(), "bookmarks.html");
  fs.writeFileSync(exported, EXPORT);
  const dry = json(roll, ["import", "bookmarks", exported, "--dry-run"]);
  assert.deepEqual(dry.create, ["Example & Co", "gitroll", "Single quotes, milliseconds", "example.net/untitled"]);
  assert.deepEqual(dry.problems, [{ row: 3, message: "Bookmarklet isn't a web page (javascript:alert(1)), so it was left out." }]);
  assert.equal(roll.git(["rev-list", "--count", "HEAD"]).trim(), String(Number(commits) + 1), "a dry run writes nothing");
  const imported = json(roll, ["import", "bookmarks", exported]);
  assert.equal(imported.created.length, 4);
  assert.match(roll.git(["log", "-1", "--format=%s"]), /^import: 4 bookmarks into bookmarks/);
  assert.match(fs.readFileSync(path.join(roll.root, ".gitroll/notes/bookmarks/gitroll.md"), "utf8"), /^description: Structured memory <in Git> — for agents$/m);
  const second = json(roll, ["import", "bookmarks", exported]);
  assert.deepEqual([second.created.length, second.skipped.length], [0, 5], "each page once");

  const nothing = path.join(tmp(), "nothing.html");
  fs.writeFileSync(nothing, "<html><body>No bookmarks</body></html>");
  assert.equal(run(roll, ["import", "bookmarks", nothing]).status, 1);

  // Another collection, for a second set of bookmarks.
  json(roll, ["bookmark", "https://example.com/work", "Work page", "--collection", "work/links"]);
  assert.deepEqual(json(roll, ["bookmarks", "--collection", "work/links"]).bookmarks.map((b: { title: string }) => b.title), ["Work page"]);
  assert.equal(json(roll, ["bookmark", "https://example.com/work", "--collection", "work/links"]).existing, true);
  assert.equal(json(roll, ["bookmark", "https://example.com/work"]).existing, false, "a different collection is a different set");
  const bad = run(roll, ["bookmarks", "--collection", "..", "--json"]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, "INVALID_ARGUMENT");

  const schema = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "schema", "bookmark"], { encoding: "utf8", cwd: tmp(), timeout: 10_000 });
  assert.deepEqual(Object.keys(JSON.parse(schema.stdout).commands[0].options), ["repo", "roll", "tag", "description", "collection"]);
});

test("bookmark and bookmarks are MCP tools", () => {
  const tools = new Map(mcpTools().map((t) => [t.name, t]));
  const add = tools.get("gitroll_bookmark")!;
  assert.deepEqual(add.inputSchema.required, ["url"]);
  assert.equal(add.annotations.readOnlyHint, false);
  assert.equal(add.inputSchema.properties.tag.type, "array");
  assert.ok(tools.get("gitroll_bookmarks")!.annotations.readOnlyHint);
});
