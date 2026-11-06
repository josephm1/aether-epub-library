import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Book } from "./epub.mjs";
const digest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
const skipped = new Set([".git", ".cache", "node_modules", "__pycache__"]);
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export class Library {
  static async open(folder, data) {
    const root = await fs.realpath(folder);
    if (!(await fs.stat(root)).isDirectory())
      throw Error("Choose an accessible library folder");
    const library = new Library();
    library.root = root;
    library.file = path.join(data, digest(root) + ".json");
    library.catalog = await readJSON(library.file, { books: [], lastScan: 0 });
    return library;
  }
  async refresh(signal) {
    const previous = new Map(this.catalog.books.map((b) => [b.path, b])),
      books = [];
    let updated = 0;
    const walk = async (directory) => {
      for (const entry of (
        await fs.readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !skipped.has(entry.name)) await walk(file);
        if (
          !entry.isFile() ||
          path.extname(entry.name).toLowerCase() !== ".epub"
        )
          continue;
        const relative = path.relative(this.root, file),
          stat = await fs.stat(file, { bigint: true }),
          modified = String(stat.mtimeNs),
          size = String(stat.size),
          old = previous.get(relative);
        previous.delete(relative);
        if (old && old.modified === modified && old.size === size) {
          books.push(old);
          continue;
        }
        const record = {
          id: digest([this.root, relative, size, modified].join("\0")),
          path: relative,
          size,
          modified,
          title: path.basename(file, path.extname(file)).slice(0, 240),
          authors: [],
          title_source: "filename",
          error: "",
        };
        let book;
        try {
          book = await Book.open(file);
          record.title = book.title;
          record.authors = book.authors;
          record.title_source = book.titleSource;
        } catch (error) {
          record.error = error.message.slice(0, 240);
        } finally {
          book?.close();
        }
        books.push(record);
        updated++;
      }
    };
    await walk(this.root);
    signal?.throwIfAborted();
    const catalog = { books, lastScan: Date.now() };
    await writeJSON(this.file, catalog);
    this.catalog = catalog;
    return {
      books: books.length,
      updated,
      removed: previous.size,
      errors: books.filter((b) => b.error).length,
    };
  }
  async query(args, refreshSeconds = 60, signal) {
    if (args.action === "refresh") return this.refresh(signal);
    if (Date.now() - this.catalog.lastScan >= refreshSeconds * 1000)
      await this.refresh(signal);
    signal?.throwIfAborted();
    const offset = Math.max(0, args.offset || 0);
    if (args.action === "titles") {
      const terms = (args.query || "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const found = this.catalog.books
        .filter((b) =>
          terms.every((t) =>
            [b.title, ...b.authors, b.path].join(" ").toLowerCase().includes(t),
          ),
        )
        .sort((a, b) => a.title.localeCompare(b.title));
      return {
        total: found.length,
        books: found
          .slice(offset, offset + 20)
          .map(({ id, title, authors, error, title_source }) => ({
            id,
            title,
            authors,
            error,
            title_source,
          })),
        next_offset: offset + 20 < found.length ? offset + 20 : null,
      };
    }
    const record = this.catalog.books.find((b) => b.id === args.book_id);
    if (!record) throw Error("Book not in this library; search titles again");
    const file = await fs.realpath(path.join(this.root, record.path)),
      relative = path.relative(this.root, file);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      throw Error("Book leaves the configured library folder");
    const stat = await fs.stat(file, { bigint: true });
    if (
      String(stat.size) !== record.size ||
      String(stat.mtimeNs) !== record.modified
    )
      throw Error("Book changed; refresh and inspect its contents again");
    const book = await Book.open(file);
    try {
      const entries = await book.contents();
      if (args.action === "contents")
        return {
          book_id: record.id,
          title: book.title,
          sections: entries.slice(offset, offset + 40),
          next_offset: offset + 40 < entries.length ? offset + 40 : null,
        };
      const index = Number(args.section_id);
      if (!Number.isInteger(index) || index < 0 || index >= entries.length)
        throw Error("Use a section ID from contents");
      let { content, headings } = await book.section(entries, index);
      if (args.action === "headings")
        return {
          book_id: record.id,
          section_id: String(index),
          headings: headings.slice(offset, offset + 40),
          next_offset: offset + 40 < headings.length ? offset + 40 : null,
        };
      if (args.action !== "read") throw Error("Unknown library action");
      if (args.heading_offset !== undefined) {
        const selected = headings.find((h) => h.offset === args.heading_offset);
        if (!selected) throw Error("Use a heading offset from headings");
        const end =
          headings.find(
            (h) => h.offset > selected.offset && h.level <= selected.level,
          )?.offset ?? content.length;
        content = content.slice(selected.offset, end);
      }
      const limit = Math.max(1, Math.min(6000, args.limit ?? 4000)),
        entry = entries[index];
      return {
        book_id: record.id,
        title: book.title,
        authors: book.authors,
        section_id: String(index),
        section: entry.title,
        location: entry.path + (entry.anchor ? "#" + entry.anchor : ""),
        heading_offset: args.heading_offset,
        offset,
        text: content.slice(offset, offset + limit),
        next_offset: offset + limit < content.length ? offset + limit : null,
      };
    } finally {
      book.close();
    }
  }
}
