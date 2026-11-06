import { applyFolder, configuration } from "./lib/runtime.mjs";
export async function activateAether(api) {
  let config = await configuration(),
    busy = false,
    failure = "",
    unregister,
    disposed = false;
  function settings() {
    if (disposed) return;
    unregister?.();
    const summary = config?.summary;
    unregister = api.registerSettings({
      id: "library",
      title: "EPUB Library",
      subtitle: "Local books · chapters on demand",
      icon: "book",
      sections: [
        {
          title: "Library folder",
          settings: [
            {
              id: "folder",
              type: "text",
              label: "EPUB library folder",
              default: config?.folder || "",
              placeholder: "Folder path accessible to Aether",
            },
            {
              id: "refresh-seconds",
              type: "number",
              label: "Check for changes when queried (seconds)",
              default: 60,
              min: 10,
              max: 3600,
            },
            {
              id: "apply",
              type: "button",
              label: busy ? "Scanning…" : "Apply folder and scan",
              action: "scan",
              enabled: !busy,
            },
            {
              id: "status",
              type: "label",
              label:
                failure ||
                (busy
                  ? "Scanning titles locally; no book text is sent to AI."
                  : summary
                    ? `${summary.books} books · ${summary.errors} unreadable · last scan ${config.last_scan}`
                    : "Choose a folder, then apply and scan."),
            },
            {
              id: "active",
              type: "label",
              label: config
                ? `Active folder: ${config.folder}`
                : "No active library.",
            },
            {
              id: "help",
              type: "label",
              label:
                "Change the folder above at any time, then apply it. Nested folders are scanned; source books are never edited. The folder must be accessible to Aether’s runtime. Enable the Python runtime profile if needed.",
            },
          ],
        },
      ],
    });
    api.invalidate();
  }
  api.registerAction("scan", () => {
    if (busy) return;
    const folder = api.storage.get("settings:library:folder", ""),
      seconds = api.storage.get("settings:library:refresh-seconds", 60);
    busy = true;
    failure = "";
    settings();
    // Return promptly: large-library scans must not block the native action request.
    void applyFolder(folder, seconds)
      .then((value) => {
        config = value;
      })
      .catch((error) => {
        failure = error.message;
      })
      .finally(() => {
        busy = false;
        settings();
      });
  });
  settings();
  return () => {
    disposed = true;
    unregister?.();
  };
}
