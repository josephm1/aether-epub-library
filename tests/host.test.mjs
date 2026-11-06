import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { epub } from "./fixtures.mjs";
import { unzipSync } from "fflate";
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
    const archive = unzipSync(
      await fs.readFile(
        path.join(source, "dist", `aether-epub-library-${version}.zip`),
      ),
    );
    for (const [name, data] of Object.entries(archive)) {
      const target = path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
    const books = path.join(root, "books");
    await epub(path.join(books, "nested/book.epub"));
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
    const toolResult = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {pathToFileURL} from 'node:url';
      const {default:activate}=await import(pathToFileURL(process.argv[1]+'/agent.mjs'));
      let tool;activate({registerTool:value=>tool=value});
      const titles=await tool.execute('titles',{action:'titles'});
      const id=titles.details.books[0].id;
      const passage=await tool.execute('read',{action:'read',book_id:id,section_id:'1',limit:100});
      console.log(JSON.stringify({name:tool.name,text:passage.details.text}));
    `,
        dir,
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          AETHER_EPUB_DATA: path.join(root, "data"),
        },
        encoding: "utf8",
      },
    );
    const packaged = JSON.parse(toolResult);
    assert.equal(packaged.name, "epub_library");
    assert(packaged.text.includes("ONLY_GRAIN"));
    assert(!packaged.text.includes("ONLY_HORSES"));

    const refreshed = await call("get_aether_extensions", { context: {} });
    assert(
      refreshed.snapshot.settings[0].sections[0].settings
        .find((s) => s.id === "status")
        .label.includes("1 books"),
    );
  },
);
