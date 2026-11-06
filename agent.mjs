import { queryLibrary } from "./lib/runtime.mjs";
export default function activate(pi) {
  pi.registerTool({
    name: "epub_library",
    label: "EPUB Library",
    description:
      "Discover local EPUB titles, inspect nested contents or headings, and read one bounded passage. Search titles first, then contents, then read. Folder is set in extension settings; no arbitrary file paths. Title relevance is not evidence. Offset/limit are characters, not tokens.",
    promptSnippet:
      "Search the local EPUB library by title; retrieve contents and cited passages only when needed.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["titles", "contents", "headings", "read", "refresh"],
        },
        query: { type: "string", maxLength: 300 },
        book_id: { type: "string" },
        section_id: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 6000 },
        heading_offset: { type: "integer", minimum: 0 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_id, args, signal) => {
      const result = await queryLibrary(args, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
