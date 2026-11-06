# Source access and exploration state

The EPUB Library extension is independent of this skill. Configure and change its
folder in Aether → Settings → Extensions → EPUB Library, then Apply folder and scan.
A native runtime path must be accessible to the extension; a `content://` document
URI or a remote URL is not a filesystem directory. Native shared-folder pickers
require an adapter; this release does not pretend those URIs are readable paths.

Tool actions:

- `titles`: title/author/path keyword discovery; `query` uses AND across words.
  Try fewer terms or synonyms when no candidate appears. Pages contain at most 20
  titles. No-query listing is for browsing, not dumping the whole library into chat.
- `contents`: `book_id`, optional `offset`; up to 40 navigation entries per page.
  Each has `id`, `title`, `depth`, archive `path` and optional `anchor`.
- `headings`: `book_id`, `section_id`; heading text, level and character offset
  within that navigation section. Useful for sparse tables of contents.
- `read`: `book_id`, `section_id`, optional `heading_offset`, `offset`, `limit`.
  Default 4,000 characters, maximum 6,000. Follow `next_offset` only when necessary.
  Heading offsets select that heading through its next peer/ancestor, including
  nested headings. A chapter returns its current XHTML document; chapters spanning
  multiple files require reading their listed child/continuation entries.
- `refresh`: local metadata scan, no AI. Normal queries check for changes after the
  interval configured in settings. Changed editions and folder changes produce new
  identities; re-search and inspect contents when an old identity stops resolving.

Cite the actual title, author if present, section title, archive location/anchor,
book ID and passage offset when useful. EPUBs lack stable printed page numbers;
never fabricate a page number. Keep footnote markers, uncertainty and surrounding
qualifiers; request adjacent relevant material when an isolated excerpt is ambiguous.
Malformed navigation is reported; it is not permission to invent text. DRM,
image-only pages and equations requiring visual interpretation may need other tools.

Keep a learning record such as `storylab-state.md` in the current task workspace.
Store only:

- objective and learner preferences established in conversation;
- the main narrative's time/place, current situation and unresolved decision;
- current exploration trail with the reason for each connection;
- compact discoveries linked to source references;
- unresolved/disputed claims and an explicit return checkpoint.

The trail records visited connections, not every possible related subject. Reuse a
source catalogue across topics, but do not silently import conclusions from a past
learning objective. A historical claim and a general scientific explanation need
appropriate evidence of their own.
