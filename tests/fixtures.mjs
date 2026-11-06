import fs from "node:fs/promises";
import path from "node:path";
import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
export async function writeZip(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const zip = new yazl.ZipFile();
  for (const [name, value] of Object.entries(entries))
    zip.addBuffer(Buffer.from(value), name);
  const written = pipeline(zip.outputStream, createWriteStream(file));
  zip.end();
  await written;
}
export async function epub(
  file,
  title = "Alexander and his world",
  { legacy = false, nav = true } = {},
) {
  const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const navigation =
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#parent">Food</a><ol><li><a href="chapter.xhtml#grain">Grain</a></li><li><a href="chapter.xhtml#horses">Horses</a></li></ol></li><li><a href="chapter.xhtml#war">War</a></li></ol></nav></body></html>';
  const ncx =
    '<ncx><navMap><navPoint><navLabel><text>Food</text></navLabel><content src="chapter.xhtml#parent"/><navPoint><navLabel><text>Grain</text></navLabel><content src="chapter.xhtml#grain"/></navPoint><navPoint><navLabel><text>Horses</text></navLabel><content src="chapter.xhtml#horses"/></navPoint></navPoint><navPoint><navLabel><text>War</text></navLabel><content src="chapter.xhtml#war"/></navPoint></navMap></ncx>';
  const entries = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml":
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escape(title)}</dc:title><dc:creator>Test Author</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>${nav ? (legacy ? '<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>') : ""}</manifest><spine toc="toc"><itemref idref="chapter"/></spine></package>`,
    "OPS/chapter.xhtml":
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="parent">Food</h1><p>Supply introduction.</p><h2 id="grain">Grain</h2><p>ONLY_GRAIN barley and wheat.</p><h3 id="storage">Storage</h3><p>ONLY_STORAGE dry granaries.</p><h2 id="horses">Horses</h2><p>ONLY_HORSES fodder requirements.</p><h1 id="war">War</h1><p>ONLY_WAR mobilization.</p><script>HIDDEN_SCRIPT</script></body></html>',
  };
  if (nav)
    entries["OPS/" + (legacy ? "toc.ncx" : "nav.xhtml")] = legacy
      ? ncx
      : navigation;
  await writeZip(file, entries);
}
