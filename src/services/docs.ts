// Documentation site content (served at /docs, data at /api/docs).
// Markdown under src/webserver/documentation is rendered to HTML here and kept
// in memory as ready-to-send bodies: a manifest (navigation and outlines), a
// search index, and one HTML fragment per page. The manifest and search index
// exist twice: for signed-in accounts, and for everyone else, where non-public
// sections keep their titles but lose their content.
// See src/webserver/documentation/README.md for the page format.
import path from "path";
import fs from "fs";
import crypto from "crypto";
import log from "../modules/logger";
import { highlight, languageLabel } from "./docs_highlight";

type DocHeading = { id: string; text: string; level: number };

type DocPage = {
  id: string;
  slug: string;
  title: string;
  description: string;
  order: number;
  html: string;
  headings: DocHeading[];
  // Searchable text per part of the page: [heading id, heading text, text].
  search: [string, string, string][];
};

type DocSection = {
  id: string;
  title: string;
  description: string;
  icon: string;
  public: boolean;
  pages: DocPage[];
};

type DocsResponse = { body: string; etag: string; contentType: string };
type DocsContent = { manifest: DocsResponse; search: DocsResponse };

const DOCS_DIR = path.join(import.meta.dir, "..", "webserver", "documentation");
const CALLOUTS: Record<string, string> = { note: "Note", tip: "Tip", warning: "Warning", danger: "Danger" };
// How often the content folder is checked for edits (cheap stat calls only).
const RELOAD_CHECK_MS = 2000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: source };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const value = line.slice(separator + 1).trim();
    meta[line.slice(0, separator).trim()] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: source.slice(match[0].length) };
}

// Rewrites the site's own syntax into something the Markdown renderer keeps:
// fence titles ride along inside the language name, and ":::" blocks become
// raw HTML wrappers around ordinary Markdown.
function preprocess(body: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;

  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})\s*(.*)$/);

    if (fence) {
      if (fenceMatch && fenceMatch[2][0] === fence.char && fenceMatch[2].length >= fence.length && fenceMatch[3].trim() === "") {
        fence = null;
      }
      out.push(line);
      continue;
    }

    if (fenceMatch) {
      fence = { char: fenceMatch[2][0], length: fenceMatch[2].length };
      const info = fenceMatch[3].trim();
      const lang = (info.match(/^[\w+#-]+/)?.[0] || "text").toLowerCase();
      const title = info.match(/title="([^"]*)"/)?.[1] || "";
      out.push(`${fenceMatch[1]}${fenceMatch[2]}${lang}${title ? ":::" + Buffer.from(title).toString("base64url") : ""}`);
      continue;
    }

    const directive = line.match(/^:::\s*(\w*)\s*(.*)$/);
    if (directive) {
      const [, name, rest] = directive;
      if (name === "") {
        out.push("", "</div>", "");
        continue;
      }
      if (name === "tabs") {
        out.push("", `<div class="doc-tabs">`, "");
        continue;
      }
      if (CALLOUTS[name]) {
        const title = escapeHtml(rest.trim() || CALLOUTS[name]);
        out.push("", `<div class="callout callout-${name}"><p class="callout-title">${title}</p>`, "");
        continue;
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

function renderCodeBlock(langInfo: string | undefined, escapedCode: string): string {
  const [lang, encodedTitle] = (langInfo || "text").split(":::");
  const title = encodedTitle ? Buffer.from(encodedTitle, "base64url").toString("utf8") : "";
  const code = decodeEntities(escapedCode).replace(/\n$/, "");

  return (
    `<figure class="code" data-lang="${escapeHtml(lang)}" data-label="${escapeHtml(languageLabel(lang))}"${title ? ` data-title="${escapeHtml(title)}"` : ""}>` +
    `<figcaption>` +
    `<span class="code-title">${escapeHtml(title)}</span>` +
    `<span class="code-lang">${escapeHtml(languageLabel(lang))}</span>` +
    `<button class="code-btn code-wrap" type="button" aria-label="Toggle line wrap" title="Toggle line wrap"></button>` +
    `<button class="code-btn code-copy" type="button" aria-label="Copy code" title="Copy code"></button>` +
    `</figcaption>` +
    `<pre><code>${highlight(code, lang)}</code></pre>` +
    `</figure>`
  );
}

function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<button[\s\S]*?<\/button>/g, "")
      .replace(/<\/?(?:a|b|code|del|em|i|kbd|span|strong)\b[^>]*>/g, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Splits a rendered page at its h2/h3 headings so search can link to the part
// of the page that matched.
function searchParts(html: string, intro: string): [string, string, string][] {
  const parts: [string, string, string][] = [];
  let headingId = "";
  let heading = "";
  let from = 0;
  let lead = intro;

  for (const match of html.matchAll(/<h[23] id="([^"]*)">([\s\S]*?)<a class="anchor"[\s\S]*?<\/h[23]>/g)) {
    parts.push([headingId, heading, plainText(`${lead} ${html.slice(from, match.index)}`)]);
    headingId = match[1];
    heading = plainText(match[2]);
    from = match.index + match[0].length;
    lead = "";
  }
  parts.push([headingId, heading, plainText(`${lead} ${html.slice(from)}`)]);
  return parts;
}

function renderPage(pageId: string, body: string): { html: string; headings: DocHeading[] } {
  const headings: DocHeading[] = [];

  let html = Bun.markdown.html(preprocess(body), { headings: { ids: true }, autolinks: true });

  html = html.replace(
    /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_match, langInfo: string | undefined, code: string) => renderCodeBlock(langInfo, code)
  );

  html = html.replace(/<h([23]) id="([^"]*)">([\s\S]*?)<\/h\1>/g, (_match, level: string, id: string, inner: string) => {
    headings.push({ id, text: decodeEntities(inner.replace(/<[^>]+>/g, "")).trim(), level: Number(level) });
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#/${pageId}/${id}" aria-label="Link to this section">#</a></h${level}>`;
  });

  html = html
    .replace(/<table>/g, `<div class="table-wrap"><table>`)
    .replace(/<\/table>/g, `</table></div>`)
    .replace(/<a href="(https?:\/\/[^"]*)"/g, `<a href="$1" target="_blank" rel="noopener noreferrer"`);

  return { html, headings };
}

function loadSections(): DocSection[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, "sections.json"), "utf8")) as any[];
  const sections: DocSection[] = [];

  for (const entry of manifest) {
    const dir = path.join(DOCS_DIR, entry.id);
    if (!fs.existsSync(dir)) continue;

    const pages: DocPage[] = [];
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      try {
        const slug = file.slice(0, -3);
        const id = `${entry.id}/${slug}`;
        const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8"));
        const rendered = renderPage(id, body);
        const description = meta.description || "";
        pages.push({
          id,
          slug,
          title: meta.title || slug,
          description,
          order: Number(meta.order) || 0,
          ...rendered,
          search: searchParts(rendered.html, escapeHtml(description)),
        });
      } catch (error: any) {
        log.error(`Failed to render documentation page ${entry.id}/${file}: ${error.message}`);
      }
    }

    if (pages.length === 0) continue;
    pages.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    sections.push({
      id: entry.id,
      title: entry.title || entry.id,
      description: entry.description || "",
      icon: entry.icon || "book",
      public: entry.public === true,
      pages,
    });
  }

  return sections;
}

function toResponse(body: string, contentType: string): DocsResponse {
  return { body, contentType, etag: `"${crypto.createHash("sha1").update(body).digest("base64url")}"` };
}

function buildContent(sections: DocSection[], authenticated: boolean): DocsContent {
  const readable = (section: DocSection) => section.public || authenticated;

  const manifest = JSON.stringify({
    authenticated,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      icon: section.icon,
      locked: !readable(section),
      pages: section.pages.map((page) =>
        readable(section)
          ? { id: page.id, title: page.title, description: page.description, headings: page.headings }
          : { id: page.id, title: page.title, description: "", headings: [] }
      ),
    })),
  });

  // One row per part of a page: [page id, heading id, heading text, text].
  const search = JSON.stringify(
    sections.filter(readable).flatMap((section) => section.pages.flatMap((page) => page.search.map((part) => [page.id, ...part])))
  );

  return { manifest: toResponse(manifest, "application/json"), search: toResponse(search, "application/json") };
}

// Changes whenever a content file is added, removed or edited.
function contentSignature(): string {
  try {
    const parts: string[] = [];
    for (const entry of fs.readdirSync(DOCS_DIR, { withFileTypes: true })) {
      if (entry.isFile()) {
        parts.push(`${entry.name}:${fs.statSync(path.join(DOCS_DIR, entry.name)).mtimeMs}`);
        continue;
      }
      for (const file of fs.readdirSync(path.join(DOCS_DIR, entry.name))) {
        parts.push(`${entry.name}/${file}:${fs.statSync(path.join(DOCS_DIR, entry.name, file)).mtimeMs}`);
      }
    }
    return parts.join("|");
  } catch {
    return "";
  }
}

let content = { member: buildContent([], true), anonymous: buildContent([], false) };
let pageResponses = new Map<string, { public: boolean; response: DocsResponse }>();
let signature: string | null = null;
let lastCheck = 0;

function refresh() {
  const now = Date.now();
  if (signature !== null && now - lastCheck < RELOAD_CHECK_MS) return;
  lastCheck = now;

  const current = contentSignature();
  if (current === signature) return;
  const firstLoad = signature === null;
  signature = current;

  try {
    const started = performance.now();
    const sections = loadSections();
    content = { member: buildContent(sections, true), anonymous: buildContent(sections, false) };
    pageResponses = new Map(
      sections.flatMap((section) =>
        section.pages.map((page) => [page.id, { public: section.public, response: toResponse(page.html, "text/html; charset=utf-8") }] as const)
      )
    );
    const pageCount = sections.reduce((total, section) => total + section.pages.length, 0);
    log.success(`${firstLoad ? "Loaded" : "Reloaded"} ${pageCount} documentation pages in ${(performance.now() - started).toFixed(0)}ms`);
  } catch (error: any) {
    log.error(`Failed to load documentation: ${error.message}`);
  }
}

// Navigation and page outlines. `authenticated` decides whether non-public
// sections are readable or listed as locked.
export function getDocsManifest(authenticated: boolean): DocsResponse {
  refresh();
  return (authenticated ? content.member : content.anonymous).manifest;
}

// Searchable text of every page this visitor may read.
export function getDocsSearchIndex(authenticated: boolean): DocsResponse {
  refresh();
  return (authenticated ? content.member : content.anonymous).search;
}

// One rendered page: null when it does not exist, "locked" when it needs an account.
export function getDocsPage(pageId: string, authenticated: boolean): DocsResponse | "locked" | null {
  refresh();
  const page = pageResponses.get(pageId);
  if (!page) return null;
  return page.public || authenticated ? page.response : "locked";
}

refresh();
