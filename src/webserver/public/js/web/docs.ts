// Documentation site client (/docs). Content arrives pre-rendered from
// /api/docs (src/services/docs.ts): a manifest up front, then each page and
// the search index on demand. This script handles hash routing
// (#/section/page/heading), navigation, search, and the code block, tab and
// table helpers. Routing stays in the hash because the reverse proxy rejects
// unknown paths and blacklists some path segments.

type Heading = { id: string; text: string; level: number };
type Page = { id: string; title: string; description: string; headings: Heading[] };
type Section = { id: string; title: string; description: string; icon: string; locked: boolean; pages: Page[] };
type Payload = { authenticated: boolean; sections: Section[] };
type Located = { page: Page; section: Section };
type SearchEntry = Located & { headingId: string; heading: string; text: string; lower: string };

const EDIT_URL = "https://github.com/Lillious-Networks/Frostfire-Forge-Gateway/edit/main/src/webserver/documentation/";
const ICONS = new Set(["rocket", "cpu", "shield", "box", "wrench", "gamepad", "book"]);
const FEATURED_MEMBER = ["getting-started/quick-start", "getting-started/architecture", "engine/plugins", "engine/admin-commands", "engine/spells", "tools/overview"];
const FEATURED_PUBLIC = ["player-guide/getting-started", "player-guide/controls", "player-guide/chat-and-commands", "player-guide/combat-and-spells", "player-guide/quests", "player-guide/parties"];
const FILTER_MIN_ROWS = 10;
const MAX_RESULTS = 40;
const MAX_RESULTS_PER_PAGE = 4;

// Shell elements are looked up once, before any page content exists, because
// heading ids inside a page may repeat these ids.
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = el("view");
const nav = el("nav");
const sidebar = el("sidebar");
const toc = el("toc");
const layout = document.querySelector<HTMLElement>(".layout")!;
const progress = el("progress");
const scrim = el("scrim");
const toTop = el("to-top");
const toast = el("toast");
const menuButton = el("menu-button");
const searchDialog = el("search");
const searchInput = el<HTMLInputElement>("search-input");
const searchResults = el("search-results");
const searchCount = el("search-count");
const accountLink = el<HTMLAnchorElement>("account-link");

let data: Payload = { authenticated: false, sections: [] };
const pages = new Map<string, Located>();
let readable: Page[] = [];
let currentPageId: string | null = null;
const pageHtml = new Map<string, Promise<string>>();
let routeToken = 0;
let searchIndex: SearchEntry[] | null = null;
let searchLoading: Promise<void> | null = null;
let searchHits: SearchEntry[] = [];
let searchSelected = 0;
let focusBeforeSearch: HTMLElement | null = null;
let toastTimer = 0;
let scrollQueued = false;

function icon(name: string, className = "icon"): string {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private mode); preferences just won't persist.
  }
}

function showToast(message: string) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* Theme */

function applyTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  el("theme-icon").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b1120" : "#ffffff");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  save("docs-theme", next);
}

/* Sidebar */

function collapsedSections(): Set<string> {
  try {
    return new Set(JSON.parse(load("docs-nav-collapsed") || "[]"));
  } catch {
    return new Set();
  }
}

function renderNav() {
  const collapsed = collapsedSections();
  nav.innerHTML = data.sections
    .map((section) => {
      const open = !section.locked && !collapsed.has(section.id);
      const links = section.pages
        .map((page) => `<li><a class="nav-link${section.locked ? " is-locked" : ""}" href="#/${page.id}" data-page="${page.id}">${esc(page.title)}</a></li>`)
        .join("");
      return (
        `<div class="nav-section${open ? " is-open" : ""}${section.locked ? " is-locked" : ""}" data-section="${section.id}">` +
        `<button class="nav-section-toggle" type="button" aria-expanded="${open}">` +
        icon(ICONS.has(section.icon) ? section.icon : "book") +
        `<span>${esc(section.title)}</span>` +
        (section.locked ? icon("lock", "icon nav-lock") : "") +
        icon("chevron", "icon nav-chevron") +
        `</button><ul class="nav-pages">${links}</ul></div>`
      );
    })
    .join("");
}

function toggleSection(sectionEl: HTMLElement) {
  const open = sectionEl.classList.toggle("is-open");
  sectionEl.querySelector(".nav-section-toggle")?.setAttribute("aria-expanded", String(open));
  if (sectionEl.classList.contains("is-locked")) return;

  const collapsed = collapsedSections();
  const id = sectionEl.dataset.section || "";
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  save("docs-nav-collapsed", JSON.stringify([...collapsed]));
}

function setActiveNav(pageId: string | null) {
  nav.querySelectorAll(".nav-link.is-active").forEach((link) => link.classList.remove("is-active"));
  if (!pageId) return;

  const link = nav.querySelector<HTMLElement>(`.nav-link[data-page="${pageId}"]`);
  if (!link) return;
  link.classList.add("is-active");

  const sectionEl = link.closest<HTMLElement>(".nav-section");
  if (sectionEl && !sectionEl.classList.contains("is-open")) {
    sectionEl.classList.add("is-open");
    sectionEl.querySelector(".nav-section-toggle")?.setAttribute("aria-expanded", "true");
  }

  const top = link.offsetTop;
  if (top < sidebar.scrollTop + 40 || top > sidebar.scrollTop + sidebar.clientHeight - 60) {
    sidebar.scrollTop = top - sidebar.clientHeight / 2;
  }
}

function setNavOpen(open: boolean) {
  document.body.classList.toggle("nav-open", open);
  scrim.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
}

/* Views */

function featuredPages(): Located[] {
  const ids = data.authenticated ? FEATURED_MEMBER : FEATURED_PUBLIC;
  return ids.map((id) => pages.get(id)).filter((found): found is Located => !!found && !found.section.locked);
}

function setOutline(html: string) {
  toc.innerHTML = html;
  layout.classList.toggle("no-toc", !html);
}

function showView(html: string, wide: boolean, title: string | null) {
  view.className = wide ? "view view-wide" : "view";
  view.innerHTML = html;
  setOutline("");
  document.title = title ? `${title} | Frostfire Forge Docs` : "Frostfire Forge Docs";
}

function renderHome() {
  currentPageId = null;
  setActiveNav(null);

  const first = readable[0];
  const cards = data.sections
    .map((section) => {
      const count = section.pages.length;
      return (
        `<a class="card${section.locked ? " is-locked" : ""}" href="#/${section.pages[0].id}">` +
        `<span class="card-icon">${icon(ICONS.has(section.icon) ? section.icon : "book")}</span>` +
        `<h3 class="card-title">${esc(section.title)}</h3>` +
        `<p class="card-text">${esc(section.description)}</p>` +
        `<span class="card-meta">${section.locked ? icon("lock") + "Log in to read" : `${count} ${count === 1 ? "page" : "pages"}`}</span>` +
        `</a>`
      );
    })
    .join("");

  const featured = featuredPages()
    .map(({ page }) => `<li><a href="#/${page.id}">${icon("file")}<span>${esc(page.title)}</span>${icon("arrow-right")}</a></li>`)
    .join("");

  const lead = data.authenticated
    ? "Guides and references for the game engine, the gateway, the asset server and the live editors, plus a guide for your players."
    : "Learn how to play: accounts, controls, chat, quests and more. Log in with a registered account to unlock the developer documentation.";

  showView(
    `<section class="hero">` +
      `<p class="hero-eyebrow">Documentation</p>` +
      `<h1>Build, host and play Frostfire Forge</h1>` +
      `<p>${lead}</p>` +
      `<div class="hero-actions">` +
      (first ? `<a class="button button-primary" href="#/${first.id}">Start reading${icon("arrow-right")}</a>` : "") +
      `<button class="button button-ghost" type="button" data-search>${icon("search")}Search the docs</button>` +
      (data.authenticated ? "" : `<a class="button button-ghost" href="/" data-login>${icon("user")}Log in</a>`) +
      `</div></section>` +
      `<h2 class="home-heading">Browse by area</h2><div class="card-grid">${cards}</div>` +
      (featured ? `<h2 class="home-heading">Good places to start</h2><ul class="link-list">${featured}</ul>` : ""),
    true,
    null
  );
  window.scrollTo(0, 0);
}

function renderNotice(iconName: string, title: string, text: string, actions: string) {
  currentPageId = null;
  showView(
    `<div class="notice"><div class="notice-icon">${icon(iconName)}</div><h1>${esc(title)}</h1><p>${esc(text)}</p><div class="notice-actions">${actions}</div></div>`,
    false,
    title
  );
  window.scrollTo(0, 0);
}

function renderLocked({ page, section }: Located) {
  setActiveNav(page.id);
  const open = readable[0];
  renderNotice(
    "lock",
    `${page.title} needs an account`,
    `The ${section.title} documentation opens once you log in with a registered account. The Player Guide is open to everyone.`,
    `<a class="button button-primary" href="/" data-login>Log in</a>` + (open ? `<a class="button button-ghost" href="#/${open.id}">Read the Player Guide</a>` : "")
  );
}

function renderLoadError() {
  renderNotice("warning", "The docs could not be loaded", "Check your connection and try again.", `<button class="button button-primary" type="button" onclick="location.reload()">Try again</button>`);
}

function renderNotFound() {
  setActiveNav(null);
  renderNotice("search", "Page not found", "That page does not exist, or it has moved.", `<a class="button button-primary" href="#/">Back to the docs home</a><button class="button button-ghost" type="button" data-search>Search</button>`);
}

function tocMarkup(page: Page): string {
  const headings = page.headings;
  if (headings.length === 0) return "";
  return (
    `<ul class="toc-list">` +
    headings.map((heading) => `<li><a class="toc-link level-${heading.level}" href="#/${page.id}/${heading.id}" data-heading="${esc(heading.id)}">${esc(heading.text)}</a></li>`).join("") +
    `</ul>`
  );
}

// Page HTML is fetched once and kept; hovering a link warms it up early.
function loadPage(pageId: string): Promise<string> {
  let request = pageHtml.get(pageId);
  if (!request) {
    request = fetch(`/api/docs?page=${encodeURIComponent(pageId)}`, { credentials: "same-origin" }).then((response) => {
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      return response.text();
    });
    request.catch(() => pageHtml.delete(pageId));
    pageHtml.set(pageId, request);
  }
  return request;
}

function renderPage({ page, section }: Located, html: string) {
  currentPageId = page.id;
  const index = readable.indexOf(page);
  const previous = readable[index - 1];
  const next = readable[index + 1];
  const outline = tocMarkup(page);

  showView(
    `<div class="breadcrumb"><a href="#/">Docs</a>${icon("chevron")}<a href="#/${section.pages[0].id}">${esc(section.title)}</a>${icon("chevron")}<span>${esc(page.title)}</span></div>` +
      `<header class="page-header"><h1 class="page-title">${esc(page.title)}</h1>` +
      (page.description ? `<p class="page-description">${esc(page.description)}</p>` : "") +
      `</header>` +
      (outline ? `<details class="toc-inline"><summary>On this page</summary>${outline}</details>` : "") +
      `<article class="article">${html}</article>` +
      `<footer class="page-footer">` +
      `<div class="page-meta"><a href="${EDIT_URL}${page.id}.md" target="_blank" rel="noopener noreferrer">${icon("edit")}Edit this page</a></div>` +
      `<nav class="pager" aria-label="Previous and next page">` +
      (previous ? `<a class="pager-link" href="#/${previous.id}"><span class="pager-label">${icon("arrow-left")}Previous</span><span class="pager-title">${esc(previous.title)}</span></a>` : "") +
      (next ? `<a class="pager-link is-next" href="#/${next.id}"><span class="pager-label">Next${icon("arrow-right")}</span><span class="pager-title">${esc(next.title)}</span></a>` : "") +
      `</nav></footer>`,
    false,
    page.title
  );

  setOutline(outline ? `<p class="toc-title">On this page</p>${outline}` : "");
  enhance(view.querySelector<HTMLElement>(".article")!);
  setActiveNav(page.id);
}

/* Page enhancements: code buttons, callout icons, tabs, table filters */

function selectTab(group: HTMLElement, label: string) {
  const figures = Array.from(group.querySelectorAll<HTMLElement>(":scope > figure.code"));
  group.querySelectorAll<HTMLElement>(".tab").forEach((tab, index) => {
    const selected = tab.dataset.tab === label;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    figures[index].hidden = !selected;
  });
}

function enhanceTabs(group: HTMLElement) {
  const figures = Array.from(group.querySelectorAll<HTMLElement>(":scope > figure.code"));
  if (figures.length < 2) {
    group.replaceWith(...Array.from(group.childNodes));
    return;
  }

  const labels = figures.map((figure, index) => figure.dataset.title || figure.dataset.label || `Option ${index + 1}`);
  const bar = document.createElement("div");
  bar.className = "tab-bar";
  bar.setAttribute("role", "tablist");
  for (const label of labels) {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.dataset.tab = label;
    tab.textContent = label;
    bar.append(tab);
  }
  group.prepend(bar);

  const preferred = load("docs-tab");
  selectTab(group, preferred && labels.includes(preferred) ? preferred : labels[0]);
}

function enhanceTable(wrap: HTMLElement) {
  const rows = Array.from(wrap.querySelectorAll<HTMLTableRowElement>("tbody tr"));
  if (rows.length < FILTER_MIN_ROWS) return;

  const bar = document.createElement("label");
  bar.className = "table-filter";
  bar.innerHTML = `${icon("filter")}<input type="search" placeholder="Filter ${rows.length} rows..." aria-label="Filter table rows" spellcheck="false"><span class="table-filter-count"></span>`;
  wrap.before(bar);

  const empty = document.createElement("tr");
  empty.className = "table-empty";
  empty.hidden = true;
  empty.innerHTML = `<td colspan="${rows[0].cells.length}">No rows match that filter.</td>`;
  wrap.querySelector("tbody")?.append(empty);

  const input = bar.querySelector("input")!;
  const count = bar.querySelector(".table-filter-count")!;
  input.addEventListener("input", () => {
    const term = input.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const match = !term || (row.textContent || "").toLowerCase().includes(term);
      row.hidden = !match;
      if (match) shown++;
    }
    count.textContent = term ? `${shown} of ${rows.length}` : "";
    empty.hidden = shown > 0;
  });
}

function enhance(article: HTMLElement) {
  article.querySelectorAll(".code-copy").forEach((button) => (button.innerHTML = icon("copy")));
  article.querySelectorAll(".code-wrap").forEach((button) => (button.innerHTML = icon("wrap")));
  article.querySelectorAll<HTMLElement>(".callout").forEach((callout) => {
    const type = ["tip", "warning", "danger"].find((name) => callout.classList.contains(`callout-${name}`)) || "note";
    callout.querySelector(".callout-title")?.insertAdjacentHTML("afterbegin", icon(type));
  });
  article.querySelectorAll<HTMLElement>(".doc-tabs").forEach(enhanceTabs);
  article.querySelectorAll<HTMLElement>(".table-wrap").forEach(enhanceTable);
}

/* Routing */

function hashParts(): string[] {
  try {
    return location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return ["?"];
  }
}

function scrollToHeading(headingId: string | undefined, smooth: boolean) {
  const target = headingId ? view.querySelector<HTMLElement>(`[id="${CSS.escape(headingId)}"]`) : null;
  if (target) {
    target.scrollIntoView({ behavior: smooth && !reducedMotion() ? "smooth" : "auto", block: "start" });
  } else if (!smooth) {
    window.scrollTo(0, 0);
  }
  onScroll();
}

async function route() {
  const parts = hashParts();
  const token = ++routeToken;
  setNavOpen(false);

  if (parts.length === 0) return renderHome();

  const found = pages.get(parts.slice(0, 2).join("/"));
  if (!found) {
    const section = parts.length === 1 ? data.sections.find((entry) => entry.id === parts[0]) : undefined;
    if (section) return location.replace(`#/${section.pages[0].id}`);
    return renderNotFound();
  }
  if (found.section.locked) return renderLocked(found);

  const samePage = currentPageId === found.page.id;
  if (!samePage) {
    setActiveNav(found.page.id);
    let html: string;
    try {
      html = await loadPage(found.page.id);
    } catch {
      if (token === routeToken) renderLoadError();
      return;
    }
    // A newer navigation started while this page was loading.
    if (token !== routeToken) return;
    renderPage(found, html);
  }
  scrollToHeading(parts[2], samePage);
}

/* Scroll tracking: reading progress, active outline entry, back to top */

function onScroll() {
  scrollQueued = false;
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0})`;
  toTop.hidden = window.scrollY < 600;

  if (!currentPageId) return;
  let active = "";
  for (const heading of view.querySelectorAll<HTMLElement>(".article h2[id], .article h3[id]")) {
    if (heading.getBoundingClientRect().top > 110) break;
    active = heading.id;
  }
  document.querySelectorAll<HTMLElement>(".toc-link").forEach((link) => link.classList.toggle("is-active", link.dataset.heading === active));

  const activeLink = toc.querySelector<HTMLElement>(".toc-link.is-active");
  if (activeLink && (activeLink.offsetTop < toc.scrollTop + 40 || activeLink.offsetTop > toc.scrollTop + toc.clientHeight - 60)) {
    toc.scrollTop = activeLink.offsetTop - toc.clientHeight / 2;
  }
}

/* Search */

// The index is one row per part of a page: [page id, heading id, heading, text].
// Locked pages are not in it, so they are added by title only.
function loadSearchIndex(): Promise<void> {
  searchLoading ??= fetch("/api/docs?search", { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      return response.json() as Promise<[string, string, string, string][]>;
    })
    .then((rows) => {
      const entries: SearchEntry[] = [];
      for (const [pageId, headingId, heading, text] of rows) {
        const found = pages.get(pageId);
        if (found) entries.push({ ...found, headingId, heading, text, lower: text.toLowerCase() });
      }
      for (const found of pages.values()) {
        if (found.section.locked) entries.push({ ...found, headingId: "", heading: "", text: "", lower: "" });
      }
      searchIndex = entries;
    })
    .catch(() => {
      searchLoading = null;
    });
  return searchLoading;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < 5; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

function runSearch(query: string): { hits: SearchEntry[]; terms: string[] } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || !searchIndex) return { hits: [], terms };

  const phrase = terms.join(" ");
  const scored: { entry: SearchEntry; score: number }[] = [];

  for (const entry of searchIndex) {
    const title = entry.page.title.toLowerCase();
    const heading = entry.heading.toLowerCase();
    const isPageEntry = entry.headingId === "";
    let score = 0;

    for (const term of terms) {
      const inTitle = title.includes(term);
      const inHeading = heading.includes(term);
      const inText = entry.lower.includes(term);
      // A section only matches on its own heading or text; the page title
      // alone would list every section of a matching page.
      if (!(inHeading || inText || (isPageEntry && inTitle))) {
        score = -1;
        break;
      }
      if (inTitle) score += isPageEntry ? (title === term ? 120 : 80) : 12;
      if (inHeading) score += heading === term ? 90 : 55;
      if (inText) score += 8 + countOccurrences(entry.lower, term) * 3;
    }
    if (score < 0) continue;
    if (terms.length > 1 && `${title} ${heading} ${entry.lower}`.includes(phrase)) score += 40;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const perPage = new Map<string, number>();
  const hits: SearchEntry[] = [];
  for (const { entry } of scored) {
    const used = perPage.get(entry.page.id) || 0;
    if (used >= MAX_RESULTS_PER_PAGE) continue;
    perPage.set(entry.page.id, used + 1);
    hits.push(entry);
    if (hits.length >= MAX_RESULTS) break;
  }
  return { hits, terms };
}

function markTerms(text: string, terms: string[]): string {
  if (terms.length === 0) return esc(text);
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text
    .split(pattern)
    .map((part, index) => (index % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join("");
}

function snippet(entry: SearchEntry, terms: string[]): string {
  if (entry.section.locked) return "Log in to read this page";
  if (!entry.text) return esc(entry.page.description);

  let at = -1;
  for (const term of terms) {
    const found = entry.lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = Math.max(0, at - 48);
  return (start > 0 ? "..." : "") + markTerms(entry.text.slice(start, start + 160), terms);
}

function renderSearchResults() {
  const query = searchInput.value.trim();
  const { hits, terms } = runSearch(query);
  let label = "";

  if (query) {
    searchHits = hits;
    searchCount.textContent = hits.length ? `${hits.length}${hits.length >= MAX_RESULTS ? "+" : ""} ${hits.length === 1 ? "result" : "results"}` : "";
  } else {
    searchHits = featuredPages().map((found) => ({ ...found, headingId: "", heading: "", text: found.page.description, lower: "" }));
    searchCount.textContent = "";
    label = `<div class="search-group">Jump to</div>`;
  }
  searchSelected = 0;

  if (searchHits.length === 0) {
    if (query && !searchIndex) {
      searchResults.innerHTML = `<div class="search-empty">${searchLoading ? "Loading the search index..." : "Search is unavailable right now. Try again in a moment."}</div>`;
      return;
    }
    searchResults.innerHTML = `<div class="search-empty">${query ? `No results for "${esc(query)}". Try a shorter or different term.` : "Type to search the documentation."}</div>`;
    return;
  }

  searchResults.innerHTML =
    label +
    searchHits
      .map((entry, index) => {
        const locked = entry.section.locked;
        return (
          `<div class="search-result${index === 0 ? " is-selected" : ""}" role="option" aria-selected="${index === 0}" data-index="${index}">` +
          icon(locked ? "lock" : entry.headingId ? "hash" : "file") +
          `<div class="search-result-body"><div class="search-result-title">` +
          `<span>${markTerms(entry.page.title, terms)}</span>` +
          (entry.heading ? `${icon("chevron")}<span>${markTerms(entry.heading, terms)}</span>` : "") +
          `<span class="search-result-section">${esc(entry.section.title)}</span></div>` +
          `<div class="search-result-snippet">${snippet(entry, terms)}</div></div></div>`
        );
      })
      .join("");
}

function selectSearchResult(index: number) {
  const items = searchResults.querySelectorAll<HTMLElement>(".search-result");
  if (items.length === 0) return;
  searchSelected = (index + items.length) % items.length;
  items.forEach((item, at) => {
    item.classList.toggle("is-selected", at === searchSelected);
    item.setAttribute("aria-selected", String(at === searchSelected));
  });
  items[searchSelected].scrollIntoView({ block: "nearest" });
}

function setSearchOpen(open: boolean) {
  if (open === !searchDialog.hidden) return;
  searchDialog.hidden = !open;
  document.body.classList.toggle("no-scroll", open);

  if (open) {
    focusBeforeSearch = document.activeElement as HTMLElement | null;
    searchInput.value = "";
    renderSearchResults();
    searchInput.focus();
    if (!searchIndex) loadSearchIndex().then(() => !searchDialog.hidden && searchInput.value.trim() && renderSearchResults());
  } else {
    focusBeforeSearch?.focus({ preventScroll: true });
  }
}

function openSearchResult(index: number) {
  const entry = searchHits[index];
  if (!entry) return;
  setSearchOpen(false);
  navigate(`#/${entry.page.id}${entry.headingId ? `/${entry.headingId}` : ""}`);
}

function navigate(hash: string) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* Events */

function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement;

  const copyButton = target.closest<HTMLElement>(".code-copy");
  if (copyButton) {
    const code = copyButton.closest(".code")?.querySelector("pre code")?.textContent || "";
    copyText(code).then((copied) => {
      if (!copied) return showToast("Could not copy");
      copyButton.innerHTML = icon("check");
      copyButton.classList.add("is-done");
      window.setTimeout(() => {
        copyButton.innerHTML = icon("copy");
        copyButton.classList.remove("is-done");
      }, 1600);
    });
    return;
  }

  const wrapButton = target.closest(".code-wrap");
  if (wrapButton) {
    wrapButton.closest(".code")?.classList.toggle("is-wrapped");
    return;
  }

  const tab = target.closest<HTMLElement>(".tab");
  if (tab?.dataset.tab) {
    // Matching tab groups switch together; keep the clicked tab where it is
    // on screen while groups above it change height.
    const before = tab.getBoundingClientRect().top;
    const label = tab.dataset.tab;
    save("docs-tab", label);
    view.querySelectorAll<HTMLElement>(".doc-tabs").forEach((group) => {
      if (Array.from(group.querySelectorAll<HTMLElement>(".tab")).some((entry) => entry.dataset.tab === label)) selectTab(group, label);
    });
    window.scrollBy(0, tab.getBoundingClientRect().top - before);
    return;
  }

  const sectionToggle = target.closest<HTMLElement>(".nav-section-toggle");
  if (sectionToggle?.parentElement) {
    toggleSection(sectionToggle.parentElement);
    return;
  }

  const searchResult = target.closest<HTMLElement>(".search-result");
  if (searchResult) {
    openSearchResult(Number(searchResult.dataset.index));
    return;
  }

  if (target.closest("[data-search]")) {
    setSearchOpen(true);
    return;
  }

  if (target.closest("[data-login]")) {
    // The realm selection page sends the player back here after logging in.
    try {
      sessionStorage.setItem("docs-return", location.hash);
    } catch {
      // Without session storage the login simply ends on the realm list.
    }
    return;
  }

  const link = target.closest<HTMLAnchorElement>('a[href^="#/"]');
  if (link) {
    if (link.classList.contains("anchor")) {
      copyText(link.href).then((copied) => copied && showToast("Link copied"));
    }
    // Same hash means no hashchange event, so re-run the route to scroll.
    if (link.getAttribute("href") === location.hash) route();
  }
}

function onKeyDown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    setSearchOpen(searchDialog.hidden as boolean);
    return;
  }

  if (!searchDialog.hidden) {
    if (event.key === "Escape") setSearchOpen(false);
    else if (event.key === "ArrowDown") selectSearchResult(searchSelected + 1);
    else if (event.key === "ArrowUp") selectSearchResult(searchSelected - 1);
    else if (event.key === "Enter") openSearchResult(searchSelected);
    else return;
    event.preventDefault();
    return;
  }

  if (event.key === "Escape") {
    setNavOpen(false);
    return;
  }

  const typing = (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
  if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    setSearchOpen(true);
  }
}

function bindEvents() {
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("hashchange", route);
  window.addEventListener(
    "scroll",
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(onScroll);
    },
    { passive: true }
  );

  el("theme-button").addEventListener("click", toggleTheme);
  el("search-button").addEventListener("click", () => setSearchOpen(true));
  menuButton.addEventListener("click", () => setNavOpen(!document.body.classList.contains("nav-open")));
  scrim.addEventListener("click", () => setNavOpen(false));
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" }));

  searchInput.addEventListener("input", renderSearchResults);
  searchDialog.addEventListener("mousedown", (event) => {
    if (event.target === searchDialog) setSearchOpen(false);
  });
  // Warm up a page as soon as the pointer or focus reaches a link to it.
  const prefetch = (event: Event) => {
    const href = (event.target as HTMLElement).closest?.<HTMLAnchorElement>('a[href^="#/"]')?.getAttribute("href");
    const found = href ? pages.get(href.slice(2).split("/").slice(0, 2).join("/")) : undefined;
    if (found && !found.section.locked) loadPage(found.page.id).catch(() => undefined);
  };
  document.addEventListener("mouseover", prefetch, { passive: true });
  document.addEventListener("focusin", prefetch);

  searchResults.addEventListener("mousemove", (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".search-result");
    if (item && Number(item.dataset.index) !== searchSelected) selectSearchResult(Number(item.dataset.index));
  });
}

async function init() {
  applyTheme(load("docs-theme") === "light" ? "light" : "dark");
  if (/Mac|iPhone|iPad/.test(navigator.platform)) el("search-shortcut").textContent = "⌘ K";
  bindEvents();

  try {
    const response = await fetch("/api/docs", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    data = (await response.json()) as Payload;
  } catch {
    renderLoadError();
    return;
  }

  data.sections = data.sections.filter((section) => section.pages.length > 0);
  for (const section of data.sections) {
    for (const page of section.pages) pages.set(page.id, { page, section });
  }
  readable = data.sections.flatMap((section) => (section.locked ? [] : section.pages));

  if (data.authenticated) {
    accountLink.href = "/realm-selection";
    el("account-icon").setAttribute("href", "#i-play");
    el("account-label").textContent = "Play";
  } else {
    accountLink.dataset.login = "";
  }

  renderNav();
  route();
}

init();
