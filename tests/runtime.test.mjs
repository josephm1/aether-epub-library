import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import activate from "../agent.mjs";
import { activateAether } from "../aether.mjs";
import { applyFolder, configuration, queryLibrary } from "../lib/runtime.mjs";

test("settings switch the actual library, tools retrieve a subsection, and failures retain the active folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.AETHER_EPUB_DATA;
  process.env.AETHER_EPUB_DATA = path.join(root, "data");
  t.after(() => {
    if (previous === undefined) delete process.env.AETHER_EPUB_DATA;
    else process.env.AETHER_EPUB_DATA = previous;
  });
  const python = spawnSync(
    "python3",
    [
      "-c",
      "import sys;sys.path.insert(0,'tests');from test_library import epub;from pathlib import Path;epub(Path(sys.argv[1])/'nested/book.epub');epub(Path(sys.argv[2])/'different.epub','Biology')",
      path.join(root, "first"),
      path.join(root, "second"),
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(python.status, 0, python.stderr);
  let tool, page;
  const actions = new Map(),
    storage = new Map();
  activate({
    registerTool: (value) => {
      tool = value;
    },
  });
  const release = await activateAether({
    storage: { get: (key, fallback) => storage.get(key) ?? fallback },
    registerSettings: (definition) => {
      page = definition;
      return () => {};
    },
    registerAction: (id, handler) => actions.set(id, handler),
    invalidate() {},
  });
  assert.equal(page.title, "EPUB Library");
  await assert.rejects(queryLibrary({ action: "titles" }), /Set a folder/);
  const setFolder = async (folder) => {
    storage.set("settings:library:folder", folder);
    actions.get("scan")();
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (
        !page.sections[0].settings
          .find((s) => s.id === "apply")
          .label.includes("Scanning")
      )
        return;
    }
    throw Error("Scan did not settle");
  };
  await setFolder(path.join(root, "first"));
  let result = await tool.execute("titles", { action: "titles" }, undefined);
  const listing = JSON.parse(result.content[0].text);
  assert.equal(listing.books[0].title, "Alexander and his world");
  const id = listing.books[0].id;
  const toc = await tool.execute(
    "toc",
    { action: "contents", book_id: id },
    undefined,
  );
  assert.equal(toc.details.sections[1].depth, 1);
  const read = await tool.execute(
    "read",
    { action: "read", book_id: id, section_id: "1", limit: 4000 },
    undefined,
  );
  assert(read.details.text.includes("ONLY_GRAIN"));
  assert(!read.details.text.includes("ONLY_HORSES"));
  assert(JSON.stringify(read.content).length < 4500);
  await setFolder(path.join(root, "second"));
  assert.equal(
    (await queryLibrary({ action: "titles" })).books[0].title,
    "Biology",
  );
  await assert.rejects(
    queryLibrary({ action: "read", book_id: id, section_id: "1" }),
    /not in this library/,
  );
  await setFolder(path.join(root, "missing"));
  assert.equal((await configuration()).folder, path.join(root, "second"));
  assert(
    page.sections[0].settings
      .find((s) => s.id === "status")
      .label.includes("ENOENT"),
  );
  release();
});
