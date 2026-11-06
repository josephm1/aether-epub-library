import yauzl from "yauzl";
import { DOMParser } from "@xmldom/xmldom";
import path from "node:path";
const META_LIMIT = 2 * 1024 * 1024,
  CHAPTER_LIMIT = 4 * 1024 * 1024;
const elements = (node) =>
  Array.from(node.childNodes).filter((n) => n.nodeType === 1);
const descendants = (node) => Array.from(node.getElementsByTagName("*"));
const named = (node, name) =>
  descendants(node).filter((n) => n.localName === name);
const text = (node) =>
  node.textContent.replace(/\s+/g, " ").trim().slice(0, 240);
export function resolve(base, href) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href) || /[\\\0]/.test(href))
    throw Error("Unsupported EPUB content link");
  const [file, fragment = ""] = href.split("#"),
    decoded = decodeURIComponent(file.split("?")[0]);
  const name = decoded
    ? path.posix.normalize(path.posix.join(path.posix.dirname(base), decoded))
    : base;
  if (
    name === ".." ||
    name.startsWith("../") ||
    name.startsWith("/") ||
    /[\\\0]/.test(name)
  )
    throw Error("Content link leaves EPUB archive");
  return { path: name, anchor: decodeURIComponent(fragment) };
}
export class Book {
  static async open(file) {
    const zip = await new Promise((ok, fail) =>
      yauzl.open(
        file,
        { lazyEntries: true, autoClose: false, strictFileNames: true },
        (error, value) => (error ? fail(error) : ok(value)),
      ),
    );
    const book = new Book();
    book.zip = zip;
    book.entries = new Map();
    try {
      await new Promise((ok, fail) => {
        zip.on("error", fail);
        zip.on("end", ok);
        zip.on("entry", (entry) => {
          if (book.entries.size >= 50000 || book.entries.has(entry.fileName)) {
            fail(Error("Oversized or ambiguous EPUB directory"));
            return;
          }
          book.entries.set(entry.fileName, entry);
          zip.readEntry();
        });
        zip.readEntry();
      });
      const container = await book.xml("META-INF/container.xml");
      book.opf = named(container, "rootfile")[0]?.getAttribute("full-path");
      if (!book.opf) throw Error("No EPUB package document");
      const opf = await book.xml(book.opf),
        metadata = named(opf, "metadata")[0];
      book.title = metadata && named(metadata, "title").map(text).find(Boolean);
      book.titleSource = book.title ? "metadata" : "filename";
      book.title ||= path.basename(file, path.extname(file)).slice(0, 240);
      book.authors = metadata
        ? named(metadata, "creator").slice(0, 4).map(text)
        : [];
      book.items = named(opf, "item").map((n) =>
        Object.fromEntries(
          Array.from(n.attributes).map((a) => [a.name, a.value]),
        ),
      );
      book.spine = named(opf, "itemref")
        .map((n) => book.items.find((i) => i.id === n.getAttribute("idref")))
        .filter(Boolean);
      return book;
    } catch (error) {
      book.close();
      throw error;
    }
  }
  close() {
    this.zip.close();
  }
  async read(name, limit) {
    const entry = this.entries.get(name);
    if (!entry) throw Error("EPUB entry missing: " + name);
    if (entry.uncompressedSize > limit || entry.isEncrypted())
      throw Error("EPUB entry is encrypted or exceeds local read limit");
    const stream = await new Promise((ok, fail) =>
      this.zip.openReadStream(entry, (error, value) =>
        error ? fail(error) : ok(value),
      ),
    );
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > limit) {
        stream.destroy();
        throw Error("EPUB entry exceeds local read limit");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  async xml(name, limit = META_LIMIT) {
    const source = await this.read(name, limit);
    if (/<!ENTITY/i.test(source)) throw Error("XML entities are unsupported");
    return new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") throw Error(message);
      },
    }).parseFromString(source, "application/xml");
  }
  async contents() {
    const entries = [],
      nav = this.items.find((i) => i.properties?.split(/\s+/).includes("nav"));
    if (nav) {
      const { path: base } = resolve(this.opf, nav.href),
        document = await this.xml(base);
      const toc = named(document, "nav").find((n) =>
        n
          .getAttributeNS("http://www.idpf.org/2007/ops", "type")
          ?.split(/\s+/)
          .includes("toc"),
      );
      function walk(node, depth = 0) {
        for (const child of elements(node)) {
          if (child.localName === "a" && child.getAttribute("href"))
            entries.push({
              title: text(child),
              ...resolve(base, child.getAttribute("href")),
              depth: Math.max(0, depth - 1),
            });
          else walk(child, depth + Number(child.localName === "ol"));
        }
      }
      if (toc) walk(toc);
    }
    if (!entries.length) {
      const ncx = this.items.find(
        (i) => i["media-type"] === "application/x-dtbncx+xml",
      );
      if (ncx) {
        const { path: base } = resolve(this.opf, ncx.href),
          document = await this.xml(base);
        function walk(node, depth = 0) {
          for (const child of elements(node)) {
            if (child.localName === "navPoint") {
              const label = elements(child).find(
                  (n) => n.localName === "navLabel",
                ),
                link = elements(child).find((n) => n.localName === "content");
              if (link?.getAttribute("src"))
                entries.push({
                  title: label ? text(label) : "Section",
                  ...resolve(base, link.getAttribute("src")),
                  depth,
                });
              walk(child, depth + 1);
            } else walk(child, depth);
          }
        }
        walk(document);
      }
    }
    if (!entries.length)
      for (const item of this.spine) {
        const location = resolve(this.opf, item.href);
        entries.push({
          title: path.posix.basename(location.path),
          ...location,
          depth: 0,
        });
      }
    return entries.map((entry, index) => ({ ...entry, id: String(index) }));
  }
  async section(entries, index) {
    const entry = entries[index],
      document = await this.xml(entry.path, CHAPTER_LIMIT),
      body = named(document, "body")[0] || document;
    const stop = entries
      .slice(index + 1)
      .find(
        (e) => e.path === entry.path && e.depth <= entry.depth && e.anchor,
      )?.anchor;
    const chunks = [],
      anchors = new Map(),
      headings = [];
    let position = 0;
    const emit = (value) => {
      chunks.push(value);
      position += value.length;
    };
    function walk(node) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        emit(node.data);
        return;
      }
      if (["script", "style", "head"].includes(node.localName)) return;
      const anchor = node.getAttribute?.("id") || node.getAttribute?.("xml:id");
      if (anchor && !anchors.has(anchor)) anchors.set(anchor, position);
      if (/^h[1-6]$/.test(node.localName))
        headings.push({
          title: text(node),
          level: Number(node.localName[1]),
          offset: position,
          anchor,
        });
      for (const child of Array.from(node.childNodes)) walk(child);
      if (/^(p|div|section|li|h[1-6]|br|tr)$/.test(node.localName)) emit("\n");
    }
    walk(body);
    if (entry.anchor && !anchors.has(entry.anchor))
      throw Error("Navigation anchor is missing; inspect another section");
    const content = chunks.join(""),
      start = anchors.get(entry.anchor) ?? 0,
      end = anchors.get(stop) ?? content.length;
    if (end <= start)
      throw Error("EPUB navigation targets are out of document order");
    return {
      content: content.slice(start, end),
      headings: headings
        .filter((h) => h.offset >= start && h.offset < end)
        .map((h) => ({ ...h, offset: h.offset - start })),
    };
  }
}
