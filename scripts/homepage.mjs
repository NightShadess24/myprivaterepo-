// Replaces the toolchain's generated homepage (`bundles/index.html`) with a
// static page in the style of the classic Paperback 0.8 repository homepage:
// logo, name, "Add to Paperback" button, guide, base URL and a plain list of
// sources with their badges. Runs after `paperback-cli bundle`.
//
// Usage: node scripts/homepage.mjs [bundleFolder]

import fs from "node:fs";
import path from "node:path";

const folder = process.argv[2] ?? "bundles";
const versioning = JSON.parse(fs.readFileSync(path.join(folder, "versioning.json"), "utf8"));
const { name, description } = versioning.repository;

// Where the Bundle and Deploy workflow publishes this folder on GitHub Pages.
// The page also recomputes it from its own address when it is opened.
function deployedBaseUrl() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const ref = process.env.GITHUB_REF_NAME;
  if (!owner || !repo || !ref) return "";
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/${ref}` : `https://${host}/${repo}/${ref}`;
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const addRepoLink = (baseUrl) =>
  `paperback://addRepo?displayName=${encodeURIComponent(name)}&url=${encodeURIComponent(baseUrl)}`;

const RATING_TAGS = {
  MATURE: { label: "Mature", type: "warning" },
  ADULT: { label: "18+", type: "danger" },
};

function sourceItem(source) {
  const tags = [];
  for (const badge of source.badges ?? []) {
    tags.push(
      `<span class="el-tag el-tag--dark el-tag--mini" style="background-color:${escapeHtml(
        badge.backgroundColor,
      )};border-color:${escapeHtml(badge.backgroundColor)};color:${escapeHtml(badge.textColor)}">${escapeHtml(
        badge.label,
      )}</span>`,
    );
  }
  const rating = RATING_TAGS[String(source.contentRating).toUpperCase()];
  if (rating) {
    tags.push(
      `<span class="el-tag el-tag--dark el-tag--mini el-tag--${rating.type}">${rating.label}</span>`,
    );
  }
  return `<li title="${escapeHtml(source.description ?? "")}">${escapeHtml(source.name)}${tags.join("")}</li>`;
}

const baseUrl = deployedBaseUrl();
const sources = [...versioning.sources].sort((a, b) => a.name.localeCompare(b.name));

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta name="robots" content="noindex">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="https://paperback.moe/pb-logo.svg">
<title>${escapeHtml(name)}</title>
<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica Neue, sans-serif;
  -moz-osx-font-smoothing: grayscale;
  color: #2c3e50;
  background-color: #fff;
  padding: 3.6rem 2rem 1.5rem;
  text-align: center;
}
.title { font-weight: 700; margin-bottom: 8px; }

/* Header */
.icon { max-height: 8rem; }
h1 { font-size: 1.7rem; margin: 1rem auto; }
.pageDescription { max-width: 35rem; font-size: 1.3rem; line-height: 1.3; color: #6a8bad; margin: 1rem auto; }
.addToPaperbackButton {
  display: inline-block;
  width: 10rem;
  line-height: 1.7;
  margin: .25rem;
  padding: .4rem;
  color: #fff;
  background-color: #2e84bf;
  border-bottom: 1px solid #2977ac;
  border-radius: 4px;
  transition: background-color .1s ease;
}
.addToPaperbackButton:hover { background-color: #3992cf; text-decoration: none; }

/* Content */
.content { margin: auto; max-width: 920px; text-align: left; }
blockquote {
  font-size: .9rem;
  color: #999;
  border-left: .2rem solid #dfe2e5;
  margin: 1rem 0;
  padding: .25rem 0 .25rem 1rem;
  line-height: 1.6;
}
blockquote p { margin-top: 2px; margin-bottom: 2px; }
a { font-weight: 500; text-decoration: none; color: #2196f3; }
a:hover { text-decoration: underline; }

/* Base URL */
.baseUrl { background-color: #f0f4f8; border-radius: .4rem; padding: .1rem .1rem; overflow-wrap: anywhere; }
.baseUrl p { margin-left: 16px; }

/* Available sources */
ul { margin-top: 0; }
#listDiv { line-height: 1.5; }

/* Tags, after Element's tag component (https://element.eleme.io/#/en-US/component/tag) */
.el-tag {
  display: inline-block;
  height: 32px;
  margin-left: 4px;
  padding: 0 10px;
  line-height: 30px;
  font-size: 12px;
  color: #409eff;
  background-color: #ecf5ff;
  border: 1px solid #d9ecff;
  border-radius: 4px;
  box-sizing: border-box;
  white-space: nowrap;
}
.el-tag--dark { background-color: #409eff; border-color: #409eff; color: #fff; }
.el-tag--mini { height: 20px; padding: 0 5px; line-height: 19px; }
.el-tag--dark.el-tag--success { background-color: #67c23a; border-color: #67c23a; color: #fff; }
.el-tag--dark.el-tag--info { background-color: #909399; border-color: #909399; color: #fff; }
.el-tag--dark.el-tag--danger { background-color: #f56c6c; border-color: #f56c6c; color: #fff; }
.el-tag--dark.el-tag--warning { background-color: #e6a23c; border-color: #e6a23c; color: #fff; }
</style>
</head>
<body>
<header>
<img class="icon" src="https://paperback.moe/icons/logo-alt.svg" alt="Repository logo" onerror="this.onerror=null;this.src='https://paperback.moe/pb-logo.svg'">
<h1>${escapeHtml(name)}</h1>
<p class="pageDescription">A Paperback extensions repository</p>
<a class="addToPaperbackButton js-add-repo" href="${escapeHtml(addRepoLink(baseUrl))}">Add to Paperback</a>
</header>
<div class="content">
<p id="repositoryDescription">${escapeHtml(description)}</p>
<blockquote>
<p>A guide is available to learn everything about extensions repositories.</p>
<p>Check it <a href="https://paperback.moe/help/guides/adding-repos/">here</a> to learn how to add and use this repository in Paperback.</p>
</blockquote>
<blockquote>
<p><span>On a Paperback installed device, press </span><a class="js-add-repo" href="${escapeHtml(addRepoLink(baseUrl))}">Add to Paperback</a><span> or use the base URL to add this repository to the app.</span></p>
</blockquote>
<div class="baseUrl">
<p class="title">Base URL:</p>
<p id="baseUrl">${escapeHtml(baseUrl)}</p>
</div>
<div class="availableSources">
<p class="title">Available Sources:</p>
<div id="listDiv">
<ul>
${sources.map(sourceItem).join("\n")}
</ul>
</div>
</div>
</div>
<script>
(function () {
  if (!/^https?:$/.test(location.protocol)) return;
  var baseUrl = location.origin + location.pathname.replace(/\\/(index\\.html)?$/, "");
  var link = "paperback://addRepo?displayName=" + encodeURIComponent(${JSON.stringify(name)}) +
    "&url=" + encodeURIComponent(baseUrl);
  document.getElementById("baseUrl").textContent = baseUrl;
  document.querySelectorAll(".js-add-repo").forEach(function (a) { a.href = link; });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(folder, "index.html"), html);
console.log(`Wrote ${path.join(folder, "index.html")} (${sources.length} sources)`);
