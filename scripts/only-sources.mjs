// Test repository: publish only the sources being fixed. Everything else stays
// in the code (same as the stable repository) but is left out of the bundle.
// Edit `onlySources` in scripts/only-sources.json to add or remove one.
// Runs after `paperback-cli bundle`, before the homepage is written.
//
// Usage: node scripts/only-sources.mjs [bundleFolder]

import fs from "node:fs";
import path from "node:path";

const folder = process.argv[2] ?? "bundles";
const { onlySources } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "only-sources.json"), "utf8"),
);
const keep = new Set(onlySources);
const versioningPath = path.join(folder, "versioning.json");
const versioning = JSON.parse(fs.readFileSync(versioningPath, "utf8"));

const dropped = versioning.sources.filter((source) => !keep.has(source.id));
for (const source of dropped) {
  fs.rmSync(path.join(folder, source.id), { recursive: true, force: true });
}
versioning.sources = versioning.sources.filter((source) => keep.has(source.id));
fs.writeFileSync(versioningPath, JSON.stringify(versioning));

const missing = [...keep].filter((id) => !versioning.sources.some((source) => source.id === id));
if (missing.length) console.warn(`[only-sources] not built: ${missing.join(", ")}`);
console.log(
  `[only-sources] kept ${versioning.sources.map((source) => source.id).join(", ")}; left out ${dropped.length}`,
);
