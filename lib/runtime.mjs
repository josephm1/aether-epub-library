import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
export const dataDirectory = () =>
  path.join(
    process.env.AETHER_EPUB_DATA ||
      path.join(os.homedir(), ".aether", "epub-library"),
  );
export async function configuration() {
  try {
    return JSON.parse(
      await fs.readFile(path.join(dataDirectory(), "config.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function runReader(request, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [fileURLToPath(new URL("./library.py", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"], signal },
    );
    let output = "",
      error = "",
      finished = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(
        Error("Library operation timed out; use a smaller folder and refresh."),
      );
    }, 300000);
    function finish(failure, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      failure ? reject(failure) : resolve(value);
    }
    child.on("error", (failure) =>
      finish(
        failure.code === "ENOENT"
          ? Error(
              "Enable Python in Aether runtime settings to use EPUB Library.",
            )
          : failure,
      ),
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
        child.kill();
        finish(Error("Library output exceeded its bound."));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (error.length < 2000) error += chunk;
    });
    child.on("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (code || result.error)
          finish(Error(result.error || error || "Library reader failed"));
        else finish(null, result);
      } catch {
        finish(Error(error || "Library reader returned invalid output"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...request, data: dataDirectory() }));
  });
}
export async function applyFolder(folder, refreshSeconds = 60) {
  if (typeof folder !== "string" || !folder.trim())
    throw Error("Enter an EPUB library folder first.");
  const canonical = await fs.realpath(folder.trim());
  const result = await runReader({ folder: canonical, action: "refresh" });
  const config = {
    folder: canonical,
    refresh_seconds: Math.max(10, Math.min(3600, Number(refreshSeconds) || 60)),
    last_scan: new Date().toISOString(),
    summary: result,
  };
  await fs.mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  const target = path.join(dataDirectory(), "config.json"),
    temporary = target + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(config), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return config;
}
export async function queryLibrary(args, signal) {
  const config = await configuration();
  if (!config)
    throw Error(
      "Set a folder and choose Apply and scan in Extensions → EPUB Library.",
    );
  return runReader(
    { ...args, folder: config.folder, refresh_seconds: config.refresh_seconds },
    signal,
  );
}
