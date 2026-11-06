# EPUB Library for Aether

A small **Node.js-only** extension: choose a folder, discover EPUB titles, then
retrieve chapters or subsections only when needed. A separate StoryLab skill uses
the library for narratives and connected deep dives. The StoryLab app remains usable.

## Install

Import the extension ZIP through Aether's extension settings and enable its Pi and
Aether parts. Node 22 is supplied by Aether. No Python, database service, Calibre,
embedding model, account or runtime package installation is required. The release
bundles its ZIP/XML libraries and their licences.

In **Settings → Extensions → EPUB Library**, set the folder and choose **Apply
folder and scan**. Change it at any time; a failed scan keeps the last working
folder active. The setting accepts a **filesystem path accessible to Aether's
runtime**. Android shared-folder picker URIs and iOS security-scoped external
folders still need a native access adapter; this release does not implement one.

Import the separate StoryLab ZIP in **Agent Skills** and select it for a learning
chat. It uses the `epub_library` tool, native web tools, saved exploration notes,
and optionally Interactive UI/Anatomy. It does not alter those extensions.

## Small retrieval, local discovery

- Recursively scan title/author metadata, skipping symlinks and cache directories.
  No chapters or navigation documents are opened during cataloguing.
- Check for added, changed or removed books when queried after the chosen interval
  (60 seconds by default). Unchanged books are not reopened. No background watcher.
- Search `titles` (20 per page), inspect `contents` (40 per page), optionally inspect
  `headings`, then `read` one selected chapter/subsection with continuation offsets.
- EPUB 3 navigation, EPUB 2 NCX and spine fallback are supported. Parent sections
  include nested subsections; a subsection stops at its next peer/ancestor. Reads
  cover one XHTML file; multi-file chapters need their separate contents entries.
- Read output defaults to 4,000 characters, capped at 6,000. It includes book identity
  and section location. Original books are read-only; a small atomic JSON catalogue
  lives under `~/.aether/epub-library`. Changed editions receive new identities.

The archive reader reads the ZIP directory and only decompresses requested entries.
Metadata entries are capped at 2 MiB and chapters at 4 MiB. Malformed XML, missing
anchors and unsupported/encrypted entries produce errors. UTF-8 text is supported;
DRM, scanned images and visual equations may need other tools. Character/byte limits
are **not token measurements** or a guarantee of a 4,000-token native conversation.
No model call is made for scans or navigation; the whole library is never injected.

## Test

```sh
npm ci --ignore-scripts
npm run package
AETHER_EXTENSION_BRIDGE=/path/to/Aether/pi-bridge/dist/extension-bridge.mjs npm test
```

Nine reader tests cover metadata-only scanning, updates, identities, nested sections,
headings, pagination, malformed archives and cancellation. Another test drives the
settings/tool path; a packaged-host test loads the ZIP through Aether's real bridge.
Without the environment variable, the host test is explicitly skipped. Tests use
generated books, not personal library data. A real Project Gutenberg EPUB was also
checked locally for title discovery, contents and bounded reading.

A synthetic 1,000-book local test scanned in approximately 0.4 seconds; an unchanged
refresh took 9 ms and reopened zero books. One 20-title result page was 2,661 bytes.
These are measurements on the development computer with tiny generated EPUBs, not
phone performance predictions.

Local Linux tests pass. No paid-model learning session or physical interaction has
been automated; Android/iOS device acceptance remains pending.

Try the skill with: “Explore Alexander's army and food supply using my library and
web sources. Let me follow cavalry into horse digestion, distinguish historical
evidence from general biology, then return to the paused story when I ask.” Check
citations and the saved return point; skill validation does not prove teaching quality.

## Design references

[Ebook-MCP](https://github.com/onebirdrocks/ebook-mcp) and
[MCP EPUB Reader](https://github.com/donghch/mcp-epub-reader) informed navigation and
subsection handling. The implementation uses [yauzl](https://github.com/thejoshwolfe/yauzl)
for selective ZIP I/O and [xmldom](https://github.com/xmldom/xmldom) for XML; it does
not adopt a full MCP server or book-processing framework. Original code is MIT.
There is no Python implementation, database migration or compatibility loader.
