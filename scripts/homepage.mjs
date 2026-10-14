// Replaces the toolchain's generated homepage (`bundles/index.html`) with a
// static page that has two themes, picked with the toggle in the corner and
// remembered per browser:
//
//   - Noir (default): dark, shop-style page — slim top bar, banner links
//     with a gold accent, serif display headings, and the plain list of
//     sources with their tags under a row of filter tabs.
//   - Classic: the classic Paperback 0.8 repository page — logo, "Add to
//     Paperback" button, guide, base URL and a plain list of sources.
//
// The site publishes more than one repository (one per branch, see REPOS).
// Every page has a link for each; hovering a link shows that repository's
// sources, clicking it keeps them shown. This branch's repository is built
// into the page, the others are read from their versioning.json.
//
// Runs after `paperback-cli bundle`.
// Usage: node scripts/homepage.mjs [bundleFolder]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The repositories on this site, in the order their links are shown.
const REPOS = [
  { ref: "0.9/stable", label: "Stable" },
  { ref: "0.9/testversion", label: "Test Version" },
  { ref: "0.9/v8tov9", label: "v8 to v9" },
];

const folder = process.argv[2] ?? "bundles";
const versioning = JSON.parse(fs.readFileSync(path.join(folder, "versioning.json"), "utf8"));
const { name, description } = versioning.repository;

function branchName() {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const current = REPOS.find((repo) => repo.ref === branchName()) ?? REPOS[0];

// Where the Bundle and Deploy workflow publishes the site on GitHub Pages
// (each repository lives under it at its branch name). The page also works
// it out from its own address when it is opened.
function deployedSiteRoot() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo) return "";
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}
const siteRoot = deployedSiteRoot();
const baseUrlOf = (ref) => (siteRoot ? siteRoot + ref : "");

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// Keeps `</script>` and friends from ending the inline script early.
const jsonForScript = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

const addRepoLink = (displayName, baseUrl) =>
  `paperback://addRepo?displayName=${encodeURIComponent(displayName)}&url=${encodeURIComponent(baseUrl)}`;

const RATING_TAGS = {
  MATURE: { label: "Mature", type: "warning" },
  ADULT: { label: "18+", type: "danger" },
};

function sourceTags(source) {
  const tags = (source.badges ?? []).map((badge) => ({
    label: badge.label,
    style: `background-color:${badge.backgroundColor};border-color:${badge.backgroundColor};color:${badge.textColor}`,
  }));
  const rating = RATING_TAGS[String(source.contentRating).toUpperCase()];
  if (rating) tags.push({ label: rating.label, type: rating.type });
  return tags;
}

const tagHtml = (tag) =>
  `<span class="el-tag el-tag--dark el-tag--mini${tag.type ? ` el-tag--${tag.type}` : ""}"${
    tag.style ? ` style="${escapeHtml(tag.style)}"` : ""
  }>${escapeHtml(tag.label)}</span>`;

// Sources copied in from other repositories (scripts/aggregate.mjs) and where
// they came from, shown next to each source and in the credits.
let thirdParty = null;
try {
  thirdParty = JSON.parse(fs.readFileSync(path.join(folder, "third-party.json"), "utf8"));
} catch {
  thirdParty = null;
}
const credits = (thirdParty?.upstreams ?? [])
  .filter((upstream) => upstream.added?.length)
  .map(({ label, url, sourceCode, license, licenseFile, commit, added }) => ({
    label,
    url,
    sourceCode,
    license,
    licenseFile,
    commit: String(commit ?? "").slice(0, 7),
    count: added.length,
  }));
const originOf = new Map(
  (thirdParty?.upstreams ?? []).flatMap((upstream) =>
    (upstream.added ?? []).map((id) => [id, upstream.label]),
  ),
);

function creditsHtml(list) {
  if (!list.length) return "";
  return `<h3>Included from other repositories</h3>
<ul>
${list
  .map(
    (c) =>
      `<li><a href="${escapeHtml(c.url)}">${escapeHtml(c.label)}</a> · ${c.count} sources · ${escapeHtml(
        c.license,
      )} (<a href="licenses/${escapeHtml(c.licenseFile)}">license</a>, <a href="${escapeHtml(
        c.sourceCode,
      )}">source code</a>)${c.commit ? ` · ${escapeHtml(c.commit)}` : ""}</li>`,
  )
  .join("\n")}
</ul>
<p>Copied unchanged from those public repositories when this one is built; their authors keep the credit.</p>`;
}

function sourceItem(source) {
  const tags = sourceTags(source);
  const filters = tags.map((tag) => tag.label).join("|");
  return `<li class="source" data-tags="${escapeHtml(filters)}" title="${escapeHtml(
    source.description ?? "",
  )}">${escapeHtml(source.name)}<span class="version">${escapeHtml(source.version ?? "")}</span>${
    originOf.has(source.id)
      ? `<span class="origin">${escapeHtml(originOf.get(source.id))}</span>`
      : ""
  }${tags.map(tagHtml).join("")}</li>`;
}

const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
const sources = sortByName(versioning.sources);
const filterLabels = [
  ...new Set(sources.flatMap((source) => sourceTags(source).map((t) => t.label))),
];
const footerText = (repoName, count, buildTime) =>
  `${repoName} · ${count} source${count === 1 ? "" : "s"} · built ${String(buildTime ?? "").slice(0, 10)}`;

// What the page needs to redraw this repository after showing another one.
const embedded = {
  name,
  description,
  buildTime: versioning.buildTime,
  sources: sources.map(({ id, name, description, version, contentRating, badges }) => ({
    name,
    description,
    version,
    contentRating,
    badges,
    origin: originOf.get(id),
  })),
  credits,
};

const baseUrl = baseUrlOf(current.ref);

const repoLinks = REPOS.map(
  (repo) =>
    `<a class="repo-link" href="${escapeHtml(siteRoot ? `${siteRoot}${repo.ref}/` : `../../${repo.ref}/`)}" data-ref="${escapeHtml(repo.ref)}"${
      repo === current ? ' aria-current="true"' : ""
    }>${escapeHtml(repo.label)}</a>`,
).join("");

const html = `<!DOCTYPE html>
<html lang="en" data-theme="noir">
<head>
<meta name="robots" content="noindex">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="https://paperback.moe/pb-logo.svg">
<title>${escapeHtml(name)}</title>
<script>
try {
  var saved = localStorage.getItem("repo-theme");
  if (saved === "classic" || saved === "noir") document.documentElement.dataset.theme = saved;
} catch (e) {}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&display=swap" rel="stylesheet">
<style>
/* ---------- Shared ---------- */
* { box-sizing: border-box; }
.title { font-weight: 700; margin-bottom: 8px; }
.icon { max-height: 8rem; }
.noir-only { display: none; }
.classic-only { display: revert; }
ul { margin-top: 0; }
.version { margin-left: 8px; font-size: 12px; opacity: .55; font-variant-numeric: tabular-nums; }
.status { margin: 0; padding-left: 40px; }
.origin { margin-left: 8px; font-size: 12px; opacity: .55; }
.origin::before { content: "· "; }
.credits { font-size: 13px; line-height: 1.6; margin-top: 2rem; }
.credits h3 { font-size: 14px; margin: 0 0 .4rem; }
.credits ul { padding-left: 20px; margin: 0 0 .4rem; }
.credits p { margin: 0; opacity: .7; }

.theme-toggle {
  position: fixed;
  top: 12px;
  right: 14px;
  z-index: 20;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  border-radius: 999px;
  padding: 6px 12px;
}

/* Repository links: hover shows that repository's sources, click keeps them */
.repo-switch { display: flex; justify-content: center; flex-wrap: wrap; }
.repo-link { cursor: pointer; white-space: nowrap; }

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
  white-space: nowrap;
}
.el-tag--dark { background-color: #409eff; border-color: #409eff; color: #fff; }
.el-tag--mini { height: 20px; padding: 0 5px; line-height: 19px; }
.el-tag--dark.el-tag--success { background-color: #67c23a; border-color: #67c23a; color: #fff; }
.el-tag--dark.el-tag--info { background-color: #909399; border-color: #909399; color: #fff; }
.el-tag--dark.el-tag--danger { background-color: #f56c6c; border-color: #f56c6c; color: #fff; }
.el-tag--dark.el-tag--warning { background-color: #e6a23c; border-color: #e6a23c; color: #fff; }

/* ---------- Classic (Paperback 0.8 repository page) ---------- */
[data-theme="classic"] body {
  font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans, Helvetica Neue, sans-serif;
  -moz-osx-font-smoothing: grayscale;
  color: #2c3e50;
  background-color: #fff;
  margin: 8px;
  padding: 3.6rem 2rem 1.5rem;
  text-align: center;
}
[data-theme="classic"] h1 { font-size: 1.7rem; margin: 1rem auto; }
[data-theme="classic"] .pageDescription { max-width: 35rem; font-size: 1.3rem; line-height: 1.3; color: #6a8bad; margin: 1rem auto; }
[data-theme="classic"] .addToPaperbackButton {
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
[data-theme="classic"] .addToPaperbackButton:hover { background-color: #3992cf; text-decoration: none; }
[data-theme="classic"] .content { margin: auto; max-width: 920px; text-align: left; }
[data-theme="classic"] blockquote {
  font-size: .9rem;
  color: #999;
  border-left: .2rem solid #dfe2e5;
  margin: 1rem 0;
  padding: .25rem 0 .25rem 1rem;
  line-height: 1.6;
}
[data-theme="classic"] blockquote p { margin-top: 2px; margin-bottom: 2px; }
[data-theme="classic"] a { font-weight: 500; text-decoration: none; color: #2196f3; }
[data-theme="classic"] a:hover { text-decoration: underline; }
[data-theme="classic"] .baseUrl { background-color: #f0f4f8; border-radius: .4rem; padding: .1rem .1rem; overflow-wrap: anywhere; }
[data-theme="classic"] .baseUrl p { margin-left: 16px; }
[data-theme="classic"] #listDiv { line-height: 1.5; }
[data-theme="classic"] .sources { padding-left: 40px; }
[data-theme="classic"] .theme-toggle { background: #fff; color: #2c3e50; border: 1px solid #dfe2e5; }
[data-theme="classic"] .repo-switch { gap: 0; margin: 0 auto 1rem; }
[data-theme="classic"] .repo-link {
  padding: .35rem 1rem;
  border: 1px solid #2e84bf;
  color: #2e84bf;
  font-size: .95rem;
}
[data-theme="classic"] .repo-link:first-child { border-radius: 4px 0 0 4px; }
[data-theme="classic"] .repo-link:last-child { border-radius: 0 4px 4px 0; }
[data-theme="classic"] .repo-link + .repo-link { border-left: 0; }
[data-theme="classic"] .repo-link:hover { text-decoration: none; background: #ecf5ff; }
[data-theme="classic"] .repo-link[aria-current="true"] { background: #2e84bf; color: #fff; }

/* ---------- Noir (dark shop style) ---------- */
[data-theme="noir"] {
  --bg: #1b1b1d;
  --surface: #232326;
  --line: #e9e9e9;
  --text: #f2f2f2;
  --muted: #a3a3aa;
  --gold: #c9a45c;
  --blue: #5d9dfe;
  color-scheme: dark;
}
[data-theme="noir"] body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", Roboto, "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
}
[data-theme="noir"] .noir-only { display: revert; }
[data-theme="noir"] .classic-only,
[data-theme="noir"] [hidden] { display: none !important; }
[data-theme="noir"] a { color: var(--blue); text-decoration: none; }
[data-theme="noir"] .theme-toggle { background: transparent; color: var(--text); border: 1px solid #4a4a50; top: 9px; }
[data-theme="noir"] .theme-toggle:hover { border-color: var(--text); }

[data-theme="noir"] .topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  height: 52px;
  line-height: 52px;
  text-align: center;
  background: var(--bg);
  padding: 0 104px; /* room for the theme toggle */
  border-bottom: 1px solid #2c2c30;
  font-family: "Cormorant Garamond", "Times New Roman", serif;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: .02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-theme="noir"] .repo-switch { gap: 0; margin: 22px 0 6px; }
[data-theme="noir"] .repo-link {
  padding: 4px 22px 8px;
  color: var(--muted);
  font-family: "Cormorant Garamond", "Times New Roman", serif;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  background-image: linear-gradient(var(--gold), var(--gold));
  background-size: 0 2px;
  background-position: 50% 100%;
  background-repeat: no-repeat;
  transition: background-size .25s ease, color .2s ease;
}
[data-theme="noir"] .repo-link + .repo-link { border-left: 1px solid #55555a; }
[data-theme="noir"] .repo-link:hover,
[data-theme="noir"] .repo-link:focus-visible { color: var(--text); background-size: 60% 2px; outline: none; }
[data-theme="noir"] .repo-link[aria-current="true"] { color: var(--gold); background-size: 60% 2px; }
[data-theme="noir"] .tabs {
  display: flex;
  justify-content: center;
  justify-content: safe center;
  gap: 26px;
  overflow-x: auto;
  scrollbar-width: none;
  max-width: 920px;
  margin: 0 auto;
  padding: 0 0 26px;
}
[data-theme="noir"] .tabs::-webkit-scrollbar { display: none; }
[data-theme="noir"] .tab {
  flex: none;
  background: none;
  border: 0;
  padding: 2px 0;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  background-image: linear-gradient(var(--text), var(--text));
  background-size: 0 1px;
  background-position: 0 100%;
  background-repeat: no-repeat;
  transition: background-size .25s ease;
}
[data-theme="noir"] .tab:hover,
[data-theme="noir"] .tab[aria-pressed="true"] { background-size: 100% 1px; }
[data-theme="noir"] .tab--brand { font-family: "Cormorant Garamond", "Times New Roman", serif; font-size: 17px; font-weight: 600; }

[data-theme="noir"] main { max-width: 1100px; margin: 0 auto; padding: 8px 16px 48px; }
[data-theme="noir"] .banner {
  display: flex;
  align-items: center;
  gap: 22px;
  margin: 14px 0;
  padding: 22px 22px;
  background: #0d0d0e;
  border-top: 3px solid var(--line);
  color: var(--gold);
  text-decoration: none;
}
[data-theme="noir"] .banner__label {
  flex: none;
  width: 140px;
  padding-right: 22px;
  border-right: 1px solid #55555a;
  color: var(--text);
  font-family: "Cormorant Garamond", "Times New Roman", serif;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.1;
}
[data-theme="noir"] .banner__text { flex: 1; font-size: clamp(17px, 3.4vw, 28px); font-weight: 700; letter-spacing: .08em; }
[data-theme="noir"] .banner__chevron { flex: none; font-size: 28px; font-weight: 300; }
[data-theme="noir"] .banner:hover .banner__chevron { transform: translateX(3px); transition: transform .15s ease; }

[data-theme="noir"] .hero { text-align: center; padding: 56px 0 8px; }
[data-theme="noir"] .hero h1 {
  margin: 0;
  font-family: "Cormorant Garamond", "Times New Roman", serif;
  font-size: clamp(34px, 7vw, 56px);
  font-weight: 600;
  line-height: 1.05;
}
[data-theme="noir"] .hero p { margin: 14px auto 0; max-width: 34rem; color: var(--muted); line-height: 1.6; }
[data-theme="noir"] .baseUrlBar {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 640px;
  margin: 26px auto 0;
  padding: 8px 8px 8px 14px;
  background: #fefefe;
  border: 1px solid #ddd;
  border-radius: 4px;
}
[data-theme="noir"] .baseUrlBar code { flex: 1; color: #555; font-size: 13px; overflow-wrap: anywhere; text-align: left; }
[data-theme="noir"] .copyButton {
  flex: none;
  border: 0;
  border-radius: 3px;
  padding: 6px 12px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-theme="noir"] .section-title {
  margin: 64px 0 26px;
  text-align: center;
  font-family: "Cormorant Garamond", "Times New Roman", serif;
  font-size: clamp(30px, 6vw, 48px);
  font-weight: 600;
  letter-spacing: .06em;
  line-height: 1.1;
  color: #e6e6e6;
}
[data-theme="noir"] #listDiv { max-width: 920px; margin: 0 auto; }
[data-theme="noir"] .sources { margin: 0; padding-left: 40px; line-height: 1.5; font-size: 16px; }
[data-theme="noir"] .empty,
[data-theme="noir"] .status { color: var(--muted); }
[data-theme="noir"] .credits { max-width: 920px; margin: 48px auto 0; color: var(--muted); }
[data-theme="noir"] .credits h3 { color: var(--text); font-family: "Cormorant Garamond", "Times New Roman", serif; font-size: 20px; font-weight: 600; letter-spacing: .04em; }
[data-theme="noir"] footer { padding: 28px 16px; border-top: 1px solid #2c2c30; color: var(--muted); font-size: 12px; text-align: center; }

@media (max-width: 560px) {
  [data-theme="noir"] .banner { gap: 14px; padding: 18px 14px; }
  [data-theme="noir"] .banner__label { width: 92px; padding-right: 14px; font-size: 15px; }
  [data-theme="noir"] .repo-link { padding: 4px 14px 8px; font-size: 18px; }
  [data-theme="classic"] body { padding: 3.6rem 1rem 1.5rem; }
}
</style>
</head>
<body>
<button class="theme-toggle" type="button" aria-label="Switch theme"></button>

<!-- Noir: top bar, banners, filter tabs above the sources -->
<div class="topbar noir-only js-repo-name">${escapeHtml(name)}</div>

<main>
<!-- Classic: header -->
<header class="classic-only">
<img class="icon" src="https://paperback.moe/icons/logo-alt.svg" alt="Repository logo" onerror="this.onerror=null;this.src='https://paperback.moe/pb-logo.svg'">
<h1 class="js-repo-name">${escapeHtml(name)}</h1>
<p class="pageDescription">A Paperback extensions repository</p>
</header>

<!-- Both: one link per repository on this site -->
<nav class="repo-switch" aria-label="Repositories">${repoLinks}</nav>

<header class="classic-only">
<a class="addToPaperbackButton js-add-repo" href="${escapeHtml(addRepoLink(name, baseUrl))}">Add to Paperback</a>
</header>

<div class="noir-only">
<a class="banner js-add-repo" href="${escapeHtml(addRepoLink(name, baseUrl))}"><span class="banner__label">Paperback</span><span class="banner__text">Add this repository</span><span class="banner__chevron">›</span></a>
<a class="banner" href="https://paperback.moe/help/guides/adding-repos/"><span class="banner__label">Guide</span><span class="banner__text">How to add a repository</span><span class="banner__chevron">›</span></a>
<section class="hero">
<h1 class="js-repo-name">${escapeHtml(name)}</h1>
<p class="js-repo-description">${escapeHtml(description)}</p>
<div class="baseUrlBar"><code class="js-base-url">${escapeHtml(baseUrl)}</code><button class="copyButton" type="button">Copy URL</button></div>
</section>
<h2 class="section-title">AVAILABLE<br>SOURCES</h2>
<nav class="tabs" aria-label="Filter sources">
<button class="tab tab--brand" type="button" data-filter="" aria-pressed="true">All Sources</button>
${filterLabels.map((label) => `<button class="tab" type="button" data-filter="${escapeHtml(label)}" aria-pressed="false">${escapeHtml(label)}</button>`).join("\n")}
</nav>
</div>

<div class="content">
<div class="classic-only">
<p id="repositoryDescription" class="js-repo-description">${escapeHtml(description)}</p>
<blockquote>
<p>A guide is available to learn everything about extensions repositories.</p>
<p>Check it <a href="https://paperback.moe/help/guides/adding-repos/">here</a> to learn how to add and use this repository in Paperback.</p>
</blockquote>
<blockquote>
<p><span>On a Paperback installed device, press </span><a class="js-add-repo" href="${escapeHtml(addRepoLink(name, baseUrl))}">Add to Paperback</a><span> or use the base URL to add this repository to the app.</span></p>
</blockquote>
<div class="baseUrl">
<p class="title">Base URL:</p>
<p class="js-base-url">${escapeHtml(baseUrl)}</p>
</div>
<p class="title">Available Sources:</p>
</div>

<!-- Both: the sources -->
<div id="listDiv">
<ul class="sources">
${sources.map(sourceItem).join("\n")}
</ul>
<p class="status" hidden></p>
<p class="empty noir-only" hidden>No sources match this filter.</p>
</div>
<section class="credits js-credits"${credits.length ? "" : " hidden"}>${creditsHtml(credits)}</section>
</div>
</main>
<footer class="noir-only js-footer">${escapeHtml(footerText(name, sources.length, versioning.buildTime))}</footer>

<script>
(function () {
  var REPOS = ${jsonForScript(REPOS)};
  var CURRENT = ${jsonForScript(current.ref)};
  var BUILD_SITE_ROOT = ${jsonForScript(siteRoot)};
  var RATING_TAGS = ${jsonForScript(RATING_TAGS)};
  var data = {};
  data[CURRENT] = ${jsonForScript(embedded)};

  var root = document.documentElement;
  var themes = { noir: "☀ Classic", classic: "☾ Noir" };
  var toggle = document.querySelector(".theme-toggle");
  function applyTheme(theme) {
    root.dataset.theme = theme;
    toggle.textContent = themes[theme];
    try { localStorage.setItem("repo-theme", theme); } catch (e) {}
  }
  toggle.addEventListener("click", function () {
    applyTheme(root.dataset.theme === "noir" ? "classic" : "noir");
    if (root.dataset.theme === "classic") showAll(); // Classic ignores the filter
  });
  toggle.textContent = themes[root.dataset.theme] || themes.noir;

  // Each repository lives at <site root><branch>, e.g. …/myprivaterepo-/0.9/stable
  function siteRoot() {
    var at = location.pathname.indexOf("/" + CURRENT);
    if (/^https?:$/.test(location.protocol) && at !== -1) {
      return location.origin + location.pathname.slice(0, at + 1);
    }
    return BUILD_SITE_ROOT;
  }
  function baseUrlOf(ref) {
    var site = siteRoot();
    return site ? site + ref : "";
  }
  function addRepoLink(displayName, ref) {
    return "paperback://addRepo?displayName=" + encodeURIComponent(displayName) + "&url=" + encodeURIComponent(baseUrlOf(ref));
  }

  var list = document.querySelector(".sources");
  var tabs = document.querySelector(".tabs");
  var empty = document.querySelector(".empty");
  var status = document.querySelector(".status");
  var links = Array.prototype.slice.call(document.querySelectorAll(".repo-link"));
  var selected = CURRENT;
  var shown = CURRENT;
  var loading = {};

  links.forEach(function (link) {
    if (baseUrlOf(link.dataset.ref)) link.href = baseUrlOf(link.dataset.ref) + "/";
  });
  function labelOf(ref) {
    var repo = REPOS.filter(function (r) { return r.ref === ref; })[0];
    return repo ? repo.label : ref;
  }

  function load(ref) {
    if (data[ref] || loading[ref]) return;
    loading[ref] = true;
    var getJson = function (file, optional) {
      return fetch(baseUrlOf(ref) + "/" + file, { cache: "no-cache" }).then(function (response) {
        if (!response.ok) {
          if (optional) return null;
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      }, function (error) {
        if (optional) return null;
        throw error;
      });
    };
    Promise.all([getJson("versioning.json", false), getJson("third-party.json", true)])
      .then(function (both) {
        var versioning = both[0];
        var upstreams = (both[1] && both[1].upstreams) || [];
        var origins = {};
        upstreams.forEach(function (u) { (u.added || []).forEach(function (id) { origins[id] = u.label; }); });
        data[ref] = {
          name: versioning.repository.name,
          description: versioning.repository.description,
          buildTime: versioning.buildTime,
          sources: versioning.sources
            .map(function (s) { return Object.assign({}, s, { origin: origins[s.id] }); })
            .sort(function (a, b) { return a.name.localeCompare(b.name); }),
          credits: upstreams
            .filter(function (u) { return u.added && u.added.length; })
            .map(function (u) {
              return { label: u.label, url: u.url, sourceCode: u.sourceCode, license: u.license, licenseFile: u.licenseFile, commit: String(u.commit || "").slice(0, 7), count: u.added.length };
            }),
        };
      })
      .catch(function () {
        data[ref] = { missing: true };
      })
      .then(function () {
        loading[ref] = false;
        if (shown === ref) show(ref);
      });
  }

  function tagsOf(source) {
    var tags = (source.badges || []).map(function (badge) {
      return {
        label: badge.label,
        style: "background-color:" + badge.backgroundColor + ";border-color:" + badge.backgroundColor + ";color:" + badge.textColor,
      };
    });
    var rating = RATING_TAGS[String(source.contentRating).toUpperCase()];
    if (rating) tags.push(rating);
    return tags;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(selector, text) {
    document.querySelectorAll(selector).forEach(function (node) { node.textContent = text; });
  }

  function renderTabs(labels) {
    tabs.textContent = "";
    var all = el("button", "tab tab--brand", "All Sources");
    all.type = "button";
    all.dataset.filter = "";
    all.setAttribute("aria-pressed", "true");
    tabs.appendChild(all);
    labels.forEach(function (label) {
      var tab = el("button", "tab", label);
      tab.type = "button";
      tab.dataset.filter = label;
      tab.setAttribute("aria-pressed", "false");
      tabs.appendChild(tab);
    });
  }

  var creditsBox = document.querySelector(".js-credits");
  function renderCredits(ref, list) {
    creditsBox.textContent = "";
    creditsBox.hidden = !list || !list.length;
    if (creditsBox.hidden) return;
    creditsBox.appendChild(el("h3", "", "Included from other repositories"));
    var ul = el("ul");
    list.forEach(function (c) {
      var li = el("li");
      var link = el("a", "", c.label);
      link.href = c.url;
      li.appendChild(link);
      li.appendChild(document.createTextNode(" · " + c.count + " sources · " + c.license + " ("));
      var lic = el("a", "", "license");
      lic.href = baseUrlOf(ref) + "/licenses/" + c.licenseFile;
      li.appendChild(lic);
      li.appendChild(document.createTextNode(", "));
      var code = el("a", "", "source code");
      code.href = c.sourceCode;
      li.appendChild(code);
      li.appendChild(document.createTextNode(")" + (c.commit ? " · " + c.commit : "")));
      ul.appendChild(li);
    });
    creditsBox.appendChild(ul);
    creditsBox.appendChild(el("p", "", "Copied unchanged from those public repositories when this one is built; their authors keep the credit."));
  }

  function renderSources(sources) {
    list.textContent = "";
    var labels = [];
    sources.forEach(function (source) {
      var tags = tagsOf(source);
      var item = el("li", "source", source.name);
      item.title = source.description || "";
      item.dataset.tags = tags.map(function (t) { return t.label; }).join("|");
      item.appendChild(el("span", "version", source.version || ""));
      if (source.origin) item.appendChild(el("span", "origin", source.origin));
      tags.forEach(function (tag) {
        var span = el("span", "el-tag el-tag--dark el-tag--mini" + (tag.type ? " el-tag--" + tag.type : ""), tag.label);
        if (tag.style) span.setAttribute("style", tag.style);
        item.appendChild(span);
        if (labels.indexOf(tag.label) === -1) labels.push(tag.label);
      });
      list.appendChild(item);
    });
    renderTabs(labels);
    empty.hidden = true;
  }

  function show(ref) {
    shown = ref;
    links.forEach(function (link) {
      if (link.dataset.ref === selected) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    var repo = data[ref];
    if (!repo || repo.missing) {
      list.textContent = "";
      renderTabs([]);
      empty.hidden = true;
      status.hidden = false;
      status.textContent = repo ? "This repository isn't published yet." : "Loading sources…";
      setText(".js-repo-name", labelOf(ref));
      setText(".js-repo-description", "");
      renderCredits(ref, []);
      setText(".js-base-url", baseUrlOf(ref));
      if (!repo) load(ref);
      return;
    }
    status.hidden = true;
    setText(".js-repo-name", repo.name);
    setText(".js-repo-description", repo.description);
    setText(".js-base-url", baseUrlOf(ref));
    var count = repo.sources.length;
    setText(".js-footer", repo.name + " · " + count + (count === 1 ? " source" : " sources") + " · built " + String(repo.buildTime || "").slice(0, 10));
    document.querySelectorAll(".js-add-repo").forEach(function (a) { a.href = addRepoLink(repo.name, ref); });
    if (ref === selected) document.title = repo.name;
    renderSources(repo.sources);
    renderCredits(ref, repo.credits);
  }

  // With a mouse, hovering a link shows that repository and leaving goes back
  // to the chosen one. A click or tap chooses it. Touch gets no hover preview:
  // on iPhone the page changing under a tap cancels the tap, so "Add this
  // repository" would flip back to Stable instead of opening Paperback.
  var nav = document.querySelector(".repo-switch");
  function choose(ref) {
    selected = ref;
    try { sessionStorage.setItem("repo-choice", ref); } catch (e) {}
    show(ref);
  }
  links.forEach(function (link) {
    link.addEventListener("pointerenter", function (event) {
      if (event.pointerType === "mouse" && shown !== link.dataset.ref) show(link.dataset.ref);
    });
    link.addEventListener("click", function (event) {
      event.preventDefault();
      choose(link.dataset.ref);
    });
  });
  nav.addEventListener("pointerleave", function (event) {
    if (event.pointerType === "mouse" && shown !== selected) show(selected);
  });

  // Filter tabs (Noir)
  function showAll() {
    list.querySelectorAll(".source").forEach(function (item) { item.hidden = false; });
    empty.hidden = true;
  }
  tabs.addEventListener("click", function (event) {
    var tab = event.target.closest(".tab");
    if (!tab) return;
    var filter = tab.dataset.filter;
    tabs.querySelectorAll(".tab").forEach(function (t) { t.setAttribute("aria-pressed", String(t === tab)); });
    var count = 0;
    list.querySelectorAll(".source").forEach(function (item) {
      var match = !filter || item.dataset.tags.split("|").indexOf(filter) !== -1;
      item.hidden = !match;
      if (match) count++;
    });
    empty.hidden = count > 0;
  });

  var copy = document.querySelector(".copyButton");
  copy.addEventListener("click", function () {
    var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy URL"; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(baseUrlOf(shown)).then(done, function () {});
  });

  // Keep the repository chosen in this tab, e.g. when Safari reloads the page
  // on coming back from Paperback.
  try {
    var saved = sessionStorage.getItem("repo-choice");
    if (REPOS.some(function (repo) { return repo.ref === saved; })) selected = saved;
  } catch (e) {}
  show(selected);
  REPOS.forEach(function (repo) { if (repo.ref !== CURRENT) load(repo.ref); });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(folder, "index.html"), html);
console.log(
  `Wrote ${path.join(folder, "index.html")} (${sources.length} sources, ${current.label})`,
);
