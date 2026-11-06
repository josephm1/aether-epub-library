import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library, readJSON, writeJSON } from "./library.mjs";
export const dataDirectory = () =>
  process.env.AETHER_EPUB_DATA ||
  path.join(os.homedir(), ".aether", "epub-library");
export const configuration = () =>
  readJSON(path.join(dataDirectory(), "config.json"), null);
export async function applyFolder(folder, refreshSeconds = 60) {
  if (typeof folder !== "string" || !folder.trim())
    throw Error("Enter an EPUB library folder first.");
  const canonical = await fs.realpath(folder.trim()),
    library = await Library.open(canonical, dataDirectory());
  const config = {
    folder: canonical,
    refresh_seconds: Math.max(10, Math.min(3600, Number(refreshSeconds) || 60)),
    last_scan: new Date().toISOString(),
    summary: await library.refresh(),
  };
  await writeJSON(path.join(dataDirectory(), "config.json"), config);
  return config;
}
export async function queryLibrary(args, signal) {
  const config = await configuration();
  if (!config)
    throw Error(
      "Set a folder and choose Apply and scan in Extensions → EPUB Library.",
    );
  const library = await Library.open(config.folder, dataDirectory());
  return library.query(args, config.refresh_seconds, signal);
}
