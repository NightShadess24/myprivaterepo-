// Keeps Comix's Fast Loading keys in step with the Paperback 0.8 ComixTo
// extension (acepilot147/pb-extensions, GPL-3.0), whose author updates its
// request signer and response decryptor whenever comix changes its keys.
// Run by .github/workflows/sync-comix-keys.yaml (on the default branch, for
// each repository branch); can also be run by hand.
//
// Usage: node scripts/sync-comix-keys.mjs <checkout of pb-extensions, branch 0.8>
// When the upstream files changed since the last sync (by content hash), it
// rewrites src/Comix/signed/*.ts (upstream content + our header), records the
// upstream commit in src/Comix/signed/UPSTREAM.json, bumps Comix's version,
// and prints "changed=true" (also to $GITHUB_OUTPUT). Otherwise it changes
// nothing and prints "changed=false".

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const upstream = process.argv[2];
if (!upstream) throw new Error("usage: node scripts/sync-comix-keys.mjs <pb-extensions checkout>");

const FILES = ["ComixFastSigner", "ComixFastDecrypt"];
const signedDir = path.join("src", "Comix", "signed");
const recordPath = path.join(signedDir, "UPSTREAM.json");
const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

const git = (...args) =>
  execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8" }).trim();
const commit = git("log", "-1", "--format=%H");
const date = git("log", "-1", "--format=%cs");
const subject = git("log", "-1", "--format=%s");

const raw = {};
const hashes = {};
for (const name of FILES) {
  raw[name] = fs.readFileSync(path.join(upstream, "src", "ComixTo", `${name}.ts`), "utf8");
  hashes[name] = crypto.createHash("sha256").update(raw[name]).digest("hex");
}

const output = (line) => {
  console.log(line);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
};

if (FILES.every((name) => record.files?.[name] === hashes[name])) {
  output("changed=false");
  process.exit(0);
}

for (const name of FILES) {
  const header =
    `/* SPDX-License-Identifier: GPL-3.0-only */\n` +
    `/* From acepilot147/pb-extensions (branch 0.8, src/ComixTo/${name}.ts, ` +
    `commit ${commit.slice(0, 7)} of ${date}), GPL-3.0:\n` +
    ` * https://github.com/acepilot147/pb-extensions\n` +
    ` * Copied unchanged apart from this header and formatting, by\n` +
    ` * scripts/sync-comix-keys.mjs. */\n` +
    `/* eslint-disable unicorn/no-new-array -- kept as written upstream */\n\n`;
  fs.writeFileSync(path.join(signedDir, `${name}.ts`), header + raw[name]);
}
fs.writeFileSync(
  recordPath,
  `${JSON.stringify({ repository: record.repository, branch: record.branch, commit, date, subject, files: hashes }, null, 2)}\n`,
);

const configPath = path.join("src", "Comix", "pbconfig.ts");
const config = fs.readFileSync(configPath, "utf8");
const match = /version:\s*"1\.0\.0-alpha\.(\d+)"/.exec(config);
if (!match) throw new Error("Comix version not found");
const version = `1.0.0-alpha.${Number(match[1]) + 1}`;
fs.writeFileSync(configPath, config.replace(match[0], `version: "${version}"`));

output("changed=true");
output(`version=${version}`);
output(`upstream=${commit.slice(0, 7)} (${date}): ${subject}`);
