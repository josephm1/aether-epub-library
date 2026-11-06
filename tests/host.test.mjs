import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const bridge = process.env.AETHER_EXTENSION_BRIDGE;
test(
  "packaged extension exposes changeable native settings and applies a real folder through Aether",
  { skip: !bridge },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-real-host-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = fileURLToPath(new URL("..", import.meta.url));
    const version = JSON.parse(
      await fs.readFile(path.join(source, "package.json"), "utf8"),
    ).version;
    const dir = path.join(root, ".aether/extensions/aether-epub-library");
    await fs.mkdir(dir, { recursive: true });
    execFileSync("python3", [
      "-c",
      "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      path.join(source, "dist", `aether-epub-library-${version}.zip`),
      dir,
    ]);
    const books = path.join(root, "books");
    execFileSync(
      "python3",
      [
        "-c",
        "import sys;sys.path.insert(0,'tests');from test_library import epub;from pathlib import Path;epub(Path(sys.argv[1])/'nested/book.epub')",
        books,
      ],
      { cwd: source },
    );
    const child = spawn(process.execPath, [bridge], {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        AETHER_EPUB_DATA: path.join(root, "data"),
      },
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => child.kill());
    const pending = new Map();
    let sequence = 0,
      errors = "";
    child.stderr.on("data", (b) => (errors += b));
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line),
        entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      frame.ok === false || frame.type === "error"
        ? entry.reject(Error(JSON.stringify(frame.error)))
        : entry.resolve(frame.payload);
    });
    const call = (type, payload = {}) =>
      new Promise((resolve, reject) => {
        const id = String(++sequence),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error("Host timed out: " + errors));
          }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, type, payload }) + "\n");
      });
    const loaded = await call("reload_aether_extensions", { context: {} });
    assert.equal(loaded.snapshot.errors.length, 0, errors);
    assert.equal(loaded.snapshot.settings.length, 1);
    const extension_id = loaded.snapshot.extensions[0].id;
    await call("invoke_aether_extension_action", {
      extension_id,
      action: "settings:library:folder",
      args: { value: books },
      context: {},
    });
    await call("invoke_aether_extension_action", {
      extension_id,
      action: "scan",
      args: {},
      context: {},
    });
    let config;
    for (let i = 0; i < 200; i++) {
      try {
        config = JSON.parse(
          await fs.readFile(path.join(root, "data/config.json"), "utf8"),
        );
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(config?.folder, books);
    assert.equal(config.summary.books, 1);
    const refreshed = await call("get_aether_extensions", { context: {} });
    assert(
      refreshed.snapshot.settings[0].sections[0].settings
        .find((s) => s.id === "status")
        .label.includes("1 books"),
    );
  },
);
