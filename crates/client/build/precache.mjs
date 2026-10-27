// Trunk post-build hook: writes the app shell's file list and a build version
// into the staged sw.js, so the service worker can cache the shell up front.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const staging = process.env.TRUNK_STAGING_DIR;
if (!staging) {
  throw new Error("TRUNK_STAGING_DIR is not set; run this as a Trunk hook");
}

const files = readdirSync(staging, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((path) => relative(staging, path) !== "sw.js")
  .sort();

const hash = createHash("sha256");
const urls = files.map((path) => {
  const url = "/" + relative(staging, path).split(sep).join("/");
  hash.update(url).update(readFileSync(path));
  return url;
});
const version = hash.digest("hex").slice(0, 16);

const swPath = join(staging, "sw.js");
const sw = readFileSync(swPath, "utf8")
  .replace('"__VERSION__"', JSON.stringify(version))
  .replace('["__PRECACHE__"]', JSON.stringify(urls));
writeFileSync(swPath, sw);
console.log(`sw.js: precaching ${urls.length} files, version ${version}`);
