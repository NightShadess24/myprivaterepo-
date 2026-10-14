// Replaces the toolchain's generated homepage (`bundles/index.html`) with a
// static page that has two themes, picked with the toggle in the corner and
// remembered per browser:
//
//   - Noir (default): dark, shop-style page — slim top bar, filter tabs,
//     banner links with a gold accent, serif display headings and the plain
//     list of sources with their tags.
//   - Classic: the classic Paperback 0.8 repository page — logo, "Add to
//     Paperback" button, guide, base URL and a plain list of sources.
//
// Runs after `paperback-cli bundle`.
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

function sourceItem(source) {
  const tags = sourceTags(source);
  const filters = tags.map((tag) => tag.label).join("|");
  return `<li class="source" data-tags="${escapeHtml(filters)}" title="${escapeHtml(
    source.description ?? "",
  )}">${escapeHtml(source.name)}${tags.map(tagHtml).join("")}</li>`;
}

const baseUrl = deployedBaseUrl();
const sources = [...versioning.sources].sort((a, b) => a.name.localeCompare(b.name));
const filterLabels = [
  ...new Set(sources.flatMap((source) => sourceTags(source).map((t) => t.label))),
];

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
[data-theme="noir"] .tabs {
  display: flex;
  gap: 26px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 18px 16px 14px;
  max-width: 1100px;
  margin: 0 auto;
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

[data-theme="noir"] main { max-width: 1100px; margin: 0 auto; padding: 0 16px 48px; }
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
  margin: 64px 0 34px;
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
[data-theme="noir"] .empty { color: var(--muted); }
[data-theme="noir"] footer { padding: 28px 16px; border-top: 1px solid #2c2c30; color: var(--muted); font-size: 12px; text-align: center; }

@media (max-width: 560px) {
  [data-theme="noir"] .banner { gap: 14px; padding: 18px 14px; }
  [data-theme="noir"] .banner__label { width: 92px; padding-right: 14px; font-size: 15px; }
  [data-theme="classic"] body { padding: 3.6rem 1rem 1.5rem; }
}
</style>
</head>
<body>
<button class="theme-toggle" type="button" aria-label="Switch theme"></button>

<!-- Noir: top bar, filter tabs, banners -->
<div class="topbar noir-only">${escapeHtml(name)}</div>
<nav class="tabs noir-only" aria-label="Filter sources">
<button class="tab tab--brand" type="button" data-filter="" aria-pressed="true">All Sources</button>
${filterLabels.map((label) => `<button class="tab" type="button" data-filter="${escapeHtml(label)}" aria-pressed="false">${escapeHtml(label)}</button>`).join("\n")}
</nav>

<main>
<div class="noir-only">
<a class="banner js-add-repo" href="${escapeHtml(addRepoLink(baseUrl))}"><span class="banner__label">Paperback</span><span class="banner__text">Add this repository</span><span class="banner__chevron">›</span></a>
<a class="banner" href="https://paperback.moe/help/guides/adding-repos/"><span class="banner__label">Guide</span><span class="banner__text">How to add a repository</span><span class="banner__chevron">›</span></a>
<section class="hero">
<h1>${escapeHtml(name)}</h1>
<p>${escapeHtml(description)}</p>
<div class="baseUrlBar"><code class="js-base-url">${escapeHtml(baseUrl)}</code><button class="copyButton" type="button">Copy URL</button></div>
</section>
<h2 class="section-title">AVAILABLE<br>SOURCES</h2>
</div>

<!-- Classic: header, guide, base URL -->
<header class="classic-only">
<img class="icon" src="https://paperback.moe/icons/logo-alt.svg" alt="Repository logo" onerror="this.onerror=null;this.src='https://paperback.moe/pb-logo.svg'">
<h1>${escapeHtml(name)}</h1>
<p class="pageDescription">A Paperback extensions repository</p>
<a class="addToPaperbackButton js-add-repo" href="${escapeHtml(addRepoLink(baseUrl))}">Add to Paperback</a>
</header>
<div class="content">
<div class="classic-only">
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
<p class="js-base-url">${escapeHtml(baseUrl)}</p>
</div>
<p class="title">Available Sources:</p>
</div>

<!-- Both: the sources -->
<div id="listDiv">
<ul class="sources">
${sources.map(sourceItem).join("\n")}
</ul>
<p class="empty noir-only" hidden>No sources match this filter.</p>
</div>
</div>
</main>
<footer class="noir-only">${escapeHtml(name)} · ${sources.length} sources · built ${escapeHtml(
  versioning.buildTime.slice(0, 10),
)}</footer>

<script>
(function () {
  var root = document.documentElement;
  var themes = { noir: "☀ Classic", classic: "☾ Noir" };
  var toggle = document.querySelector(".theme-toggle");
  function apply(theme) {
    root.dataset.theme = theme;
    toggle.textContent = themes[theme];
    try { localStorage.setItem("repo-theme", theme); } catch (e) {}
  }
  toggle.addEventListener("click", function () { apply(root.dataset.theme === "noir" ? "classic" : "noir"); });
  toggle.textContent = themes[root.dataset.theme] || themes.noir;

  // Filter tabs (Noir)
  var items = document.querySelectorAll(".source");
  var empty = document.querySelector(".empty");
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var filter = tab.dataset.filter;
      document.querySelectorAll(".tab").forEach(function (t) { t.setAttribute("aria-pressed", String(t === tab)); });
      var shown = 0;
      items.forEach(function (item) {
        var match = !filter || item.dataset.tags.split("|").indexOf(filter) !== -1;
        item.hidden = !match;
        if (match) shown++;
      });
      empty.hidden = shown > 0;
    });
  });
  // Classic theme ignores the filter
  toggle.addEventListener("click", function () {
    if (root.dataset.theme === "classic") items.forEach(function (item) { item.hidden = false; });
  });

  // Base URL from the page's own address
  var baseUrl = document.querySelector(".js-base-url").textContent.trim();
  if (/^https?:$/.test(location.protocol)) {
    baseUrl = location.origin + location.pathname.replace(/\\/(index\\.html)?$/, "");
    var link = "paperback://addRepo?displayName=" + encodeURIComponent(${JSON.stringify(name)}) +
      "&url=" + encodeURIComponent(baseUrl);
    document.querySelectorAll(".js-base-url").forEach(function (el) { el.textContent = baseUrl; });
    document.querySelectorAll(".js-add-repo").forEach(function (a) { a.href = link; });
  }

  var copy = document.querySelector(".copyButton");
  copy.addEventListener("click", function () {
    var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy URL"; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(baseUrl).then(done, function () {});
  });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(folder, "index.html"), html);
console.log(`Wrote ${path.join(folder, "index.html")} (${sources.length} sources)`);
