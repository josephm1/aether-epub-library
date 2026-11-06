# EPUB Library for Aether

A small, read-only Aether extension for discovering local EPUB books and retrieving
selected chapters or subsections. A separate StoryLab skill uses it for narratives
and connected exploration across subjects. The existing StoryLab web app remains
independent.

## Install and choose a folder

Import `aether-epub-library-0.1.0.zip` through Aether's extension settings and enable
its Pi tool and Aether settings entry. **Node 22+ and Python 3.10+ are required.**
The Node runtime is supplied by Aether; enable its Python runtime profile if needed.
The reader uses Python's standard library only; no pip packages, Calibre server,
embedding model or network service is needed.

In **Settings → Extensions → EPUB Library**, enter an accessible EPUB folder,
then choose **Apply folder and scan**. You can change it whenever you want. The
old active folder stays in use if the new scan fails. Source books are never edited.

This first version accepts a **filesystem folder path visible to Aether's runtime**.
It does not implement Android's native shared-folder picker or iOS security-scoped
folder grants. A `content://` URI is not a readable filesystem path. External device
folders may therefore need a native access adapter before they can be used. No
native app changes or platform parity claims are hidden behind this limitation.

Scans run locally in the background of the extension action. Normal library queries
check for added/changed/removed books after a configurable interval (60 seconds by
default). No always-running filesystem watcher or model request is used. Closed apps
are not scanned. Folder changes select an independent catalogue; changed editions
receive new book IDs so old references cannot silently point at revised text.

## Retrieval and efficiency

The `epub_library` tool supports progressive retrieval plus refresh:

1. `titles`: search title/author/path keywords, at most 20 results per page.
2. `contents`: inspect EPUB 3 navigation or EPUB 2 NCX, up to 40 entries per page.
3. `headings`: inspect headings inside one selected navigation section.
4. `read`: read one section or selected heading, with a continuation offset.
5. `refresh`: explicitly rescan metadata when required.

Metadata scanning opens only the archive directory, container and package document.
It does not open chapters or navigation documents. Unchanged books are skipped by
file size/mtime. Chapter bodies are opened only for requested heading inspection or
reading. A missing contents document falls back to spine entries; malformed XML or
missing anchors produce a clear error instead of invented content.

A selected chapter includes its nested subsections up to the next peer or ancestor
navigation target in the same XHTML document. A subsection excludes the following
peer. Chapters spread across multiple XHTML files must be read via their separate
contents entries; the tool does not silently concatenate them. Navigation need not
list every heading: `headings` allows finer local retrieval.

`read` defaults to 4,000 characters and is capped at 6,000, with a cursor for the next
page. Results include book identity, title, author, section, archive location and
character offset. EPUB page numbers are not invented. Local metadata entries are
bounded at 2 MiB and chapter entries at 4 MiB. Symlinks are skipped. DRM, malformed
navigation, image-only chapters and visual equations may need other readers.

These are character and byte bounds, **not measured model-token counts**. The full
catalogue, book, current settings and source HTML are not injected at activation.
There are no model calls from catalogue scanning or local navigation. The skill
cannot enforce a 4,000-token ceiling on Aether's entire native conversation.

## StoryLab skill

Import `storylab-skill-0.1.0.zip` using Aether's Agent Skills settings and select it
for a learning conversation. It is deliberately a separate install; the library
extension can also serve other skills and ordinary questions.

The skill guides narrative scenes, source-grounded decisions, cross-disciplinary
excursions and a saved return checkpoint. It uses available native web tools for
websites/Wikipedia, and Interactive UI or Anatomy only when useful. It does not
require those visual extensions or change their settings. Learning notes stay in
the task workspace rather than extending the EPUB catalogue with chat history.

Example manual test:

> Use StoryLab to explore Alexander's army and its food supply using my library
> and reliable websites. Start with a short scene, then let me explore how feeding
> cavalry connects to horse digestion. Distinguish historical evidence from general
> biology. Save where we paused. When I say “back to the story,” resume that point
> and connect what we learned to the army's provisioning choices.

Verify real citations, a saved checkpoint, a useful biology detour and a correct
return. Do not award a negative reasoning score just for differing from a historical
decision. This behavioral flow still requires model/user acceptance testing; skill
validation alone does not prove teaching quality.

## Development and validation

```sh
npm test
npm run package
AETHER_EXTENSION_BRIDGE=/path/to/Aether/pi-bridge/dist/extension-bridge.mjs npm test
```

Eight Python tests exercise actual generated EPUB fixtures: metadata-only scanning,
recursive discovery, incremental refresh, book revisions, folder identity, NCX/spine
fallback, nested-section boundaries, heading slicing, pagination and corrupt files.
A Node test drives native settings handlers through a mocked API and real reader.
A separate packaged-host test loads the ZIP through Aether's actual extension
bridge; set `AETHER_EXTENSION_BRIDGE` to run it. Otherwise that test is explicitly
skipped. Synthetic fixtures are created by tests; no personal library is included.

Local tests ran on Linux. No end-to-end paid-model session or physical interaction
has been automated. iOS device verification is pending. The attached device lacks
the Python runtime profile at preparation time; a successful desktop test does not
establish device readiness.

## References

Reviewed existing approaches before implementation:

- [Ebook-MCP](https://github.com/onebirdrocks/ebook-mcp): chapter/subchapter anchor
  handling; its directory listing is not recursive and its EbookLib reader loads
  the book before extraction.
- [MCP EPUB Reader](https://github.com/donghch/mcp-epub-reader): nested navigation
  and read sessions; its default parser fetches chapter content.
- [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md):
  focused instructions loaded on demand, separate from executable integrations.

The implementation here is original MIT code; these projects are references, not
vendored code or runtime dependencies. There is no backwards-compatibility loader,
legacy database migration or whole-library embedding pipeline.
