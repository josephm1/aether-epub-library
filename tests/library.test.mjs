import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../lib/library.mjs";
import { Book, resolve } from "../lib/epub.mjs";
import { epub, writeZip } from "./fixtures.mjs";
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "epub-reader-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "books"),
    data = path.join(temp, "cache");
  await epub(path.join(root, "nested/book.EPUB"));
  return { temp, root, data, library: await Library.open(root, data) };
}
async function identifier(library) {
  return (await library.query({ action: "titles" })).books[0].id;
}

test("recursive metadata-only scan does not open navigation or chapter bodies", async (t) => {
  const { library } = await fixture(t),
    opened = [],
    original = Book.prototype.read;
  Book.prototype.read = function (name, limit) {
    opened.push(name);
    return original.call(this, name, limit);
  };
  t.after(() => {
    Book.prototype.read = original;
  });
  assert.equal(
    (await library.query({ action: "titles" })).books[0].title,
    "Alexander and his world",
  );
  assert.deepEqual(opened, ["META-INF/container.xml", "OPS/book.opf"]);
  opened.length = 0;
  await library.refresh();
  assert.deepEqual(opened, []);
});

test("incremental refresh sees additions, changed editions, deletions and folder identity", async (t) => {
  const { library, root, temp, data } = await fixture(t),
    old = await identifier(library);
  await epub(path.join(root, "new.epub"), "Biology");
  assert.equal((await library.refresh()).books, 2);
  await epub(path.join(root, "nested/book.EPUB"), "A changed edition");
  await library.refresh();
  await assert.rejects(
    library.query({ action: "contents", book_id: old }),
    /not in this library/,
  );
  await fs.rm(path.join(root, "new.epub"));
  assert.equal((await library.refresh()).removed, 1);
  const other = path.join(temp, "other");
  await epub(path.join(other, "nested/book.EPUB"));
  assert.notEqual(
    await identifier(await Library.open(other, data)),
    await identifier(library),
  );
});

test("refresh is throttled but discovers new books after the interval", async (t) => {
  const { library, root } = await fixture(t);
  await identifier(library);
  await epub(path.join(root, "new.epub"), "Biology");
  assert.equal((await library.query({ action: "titles" })).total, 1);
  library.catalog.lastScan -= 61000;
  assert.equal((await library.query({ action: "titles" })).total, 2);
});

test("nested contents preserve child text and stop before the next peer", async (t) => {
  const { library } = await fixture(t),
    id = await identifier(library),
    sections = (await library.query({ action: "contents", book_id: id }))
      .sections;
  assert.deepEqual(
    sections.map((s) => s.depth),
    [0, 1, 1, 0],
  );
  const parent = await library.query({
    action: "read",
    book_id: id,
    section_id: "0",
  });
  assert(parent.text.includes("ONLY_GRAIN"));
  assert(parent.text.includes("ONLY_HORSES"));
  assert(!parent.text.includes("ONLY_WAR"));
  const child = await library.query({
    action: "read",
    book_id: id,
    section_id: "1",
  });
  assert(child.text.includes("ONLY_STORAGE"));
  assert(!child.text.includes("ONLY_HORSES"));
  assert(
    !(
      await library.query({ action: "read", book_id: id, section_id: "3" })
    ).text.includes("HIDDEN_SCRIPT"),
  );
});

test("heading reads and bounded pagination exclude neighboring subsections", async (t) => {
  const { library } = await fixture(t),
    id = await identifier(library),
    headings = (
      await library.query({ action: "headings", book_id: id, section_id: "0" })
    ).headings;
  const args = {
    action: "read",
    book_id: id,
    section_id: "0",
    heading_offset: headings.find((h) => h.title === "Storage").offset,
  };
  const whole = (await library.query(args)).text;
  assert(whole.includes("ONLY_STORAGE"));
  assert(!whole.includes("ONLY_HORSES"));
  let combined = "",
    offset = 0;
  for (;;) {
    const page = await library.query({ ...args, offset, limit: 7 });
    assert(page.text.length <= 7);
    combined += page.text;
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  assert.equal(combined, whole);
});

test("EPUB 2 NCX and sparse spine-only books support navigation and headings", async (t) => {
  const { root, data } = await fixture(t);
  await epub(path.join(root, "legacy.epub"), "Legacy", { legacy: true });
  await epub(path.join(root, "plain.epub"), "No navigation", { nav: false });
  const library = await Library.open(root, data),
    books = (await library.query({ action: "titles" })).books;
  const legacy = books.find((b) => b.title === "Legacy").id,
    plain = books.find((b) => b.title === "No navigation").id;
  assert.deepEqual(
    (await library.query({ action: "contents", book_id: legacy })).sections.map(
      (s) => s.depth,
    ),
    [0, 1, 1, 0],
  );
  assert.equal(
    (await library.query({ action: "contents", book_id: plain })).sections
      .length,
    1,
  );
  assert(
    (
      await library.query({
        action: "headings",
        book_id: plain,
        section_id: "0",
      })
    ).headings.length > 1,
  );
});

test("corrupt books are reported and symlinks are not followed", async (t) => {
  const { library, root, temp } = await fixture(t);
  await fs.writeFile(path.join(root, "bad.epub"), "broken");
  const outside = path.join(temp, "secret.epub");
  await epub(outside, "Secret");
  await fs.symlink(outside, path.join(root, "link.epub"));
  assert.equal((await library.refresh()).errors, 1);
  const result = await library.query({ action: "titles" });
  assert.equal(result.total, 2);
  assert(!JSON.stringify(result).includes("Secret"));
});

test("bad paths, missing anchors, XML entities and oversized entries fail explicitly", async (t) => {
  assert.throws(() => resolve("OPS/nav.xhtml", "../../outside"));
  assert.deepEqual(resolve("OPS/nav.xhtml", "#target"), {
    path: "OPS/nav.xhtml",
    anchor: "target",
  });
  const { root } = await fixture(t),
    book = await Book.open(path.join(root, "nested/book.EPUB"));
  t.after(() => book.close());
  await assert.rejects(book.read("OPS/chapter.xhtml", 1), /read limit/);
  const entries = await book.contents();
  entries[0].anchor = "missing";
  await assert.rejects(book.section(entries, 0), /anchor is missing/);
  const bad = path.join(root, "entities.epub");
  await writeZip(bad, {
    "META-INF/container.xml":
      '<!DOCTYPE x [<!ENTITY y "payload">]><container>&y;</container>',
  });
  await assert.rejects(Book.open(bad), /entities/);
});

test("large passage output stays bounded and aborts do not commit partial catalogues", async (t) => {
  const { library, root } = await fixture(t),
    id = await identifier(library),
    book = await Book.open(path.join(root, "nested/book.EPUB"));
  t.after(() => book.close());
  const original = Book.prototype.section;
  Book.prototype.section = async () => ({
    content: "x".repeat(10000),
    headings: [],
  });
  t.after(() => {
    Book.prototype.section = original;
  });
  const page = await library.query({
    action: "read",
    book_id: id,
    section_id: "0",
    limit: 100000,
  });
  assert.equal(page.text.length, 6000);
  assert.equal(page.next_offset, 6000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(library.refresh(controller.signal), /aborted/);
  assert.equal(library.catalog.books.length, 1);
});
