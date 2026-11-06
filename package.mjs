import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { build } from "esbuild";
import yazl from "yazl";
const root = fileURLToPath(new URL(".", import.meta.url)),
  out = path.join(root, "dist");
await fs.mkdir(out, { recursive: true });
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
await build({
  entryPoints: [path.join(root, "lib/runtime.mjs")],
  outfile: path.join(out, "runtime.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
async function archive(name, files) {
  const file = `${name}-${manifest.version}.zip`,
    zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files))
    zip.addBuffer(Buffer.from(content), name, {
      mtime: new Date("2026-11-06T00:00:00Z"),
      mode: 0o100644,
    });
  const written = pipeline(
    zip.outputStream,
    createWriteStream(path.join(out, file)),
  );
  zip.end();
  await written;
  const bytes = await fs.readFile(path.join(out, file));
  return {
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const dependencies = execFileSync("npm", ["ls", "--omit=dev", "--parseable"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .slice(1);
let notices = "";
for (const directory of dependencies) {
  const p = JSON.parse(
    await fs.readFile(path.join(directory, "package.json"), "utf8"),
  );
  const license = (await fs.readdir(directory)).find((name) =>
    /^licen[cs]e/i.test(name),
  );
  if (!license) throw Error("Missing license: " + p.name);
  notices +=
    `\n## ${p.name} ${p.version}\n\n` +
    (await fs.readFile(path.join(directory, license), "utf8"));
}
const runtimeManifest = {
  name: manifest.name,
  version: manifest.version,
  type: "module",
  license: manifest.license,
  engines: manifest.engines,
  pi: manifest.pi,
  aether: manifest.aether,
};
const extension = {
  "package.json": JSON.stringify(runtimeManifest, null, 2),
  "runtime.cjs": await fs.readFile(path.join(out, "runtime.cjs")),
  LICENSE: await fs.readFile(path.join(root, "LICENSE")),
  "THIRD_PARTY_LICENSES.txt": notices,
};
for (const name of ["agent.mjs", "aether.mjs"])
  extension[name] = (await fs.readFile(path.join(root, name), "utf8")).replace(
    "./lib/runtime.mjs",
    "./runtime.cjs",
  );
const skill = { LICENSE: extension.LICENSE };
async function walk(dir, prefix = "") {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name),
      name = prefix + entry.name;
    if (entry.isDirectory()) await walk(file, name + "/");
    else skill[name] = await fs.readFile(file);
  }
}
await walk(path.join(root, "skills/storylab"));
const artifacts = [
  await archive("aether-epub-library", extension),
  await archive("storylab-skill", skill),
];
await fs.writeFile(
  path.join(out, "ARTIFACTS.json"),
  JSON.stringify(artifacts, null, 2) + "\n",
);
await fs.writeFile(
  path.join(out, "SHA256SUMS"),
  artifacts.map((a) => `${a.sha256}  ${a.file}\n`).join(""),
);
console.log(JSON.stringify(artifacts, null, 2));
