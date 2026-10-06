# Documentation content

Everything under this folder is the source of the documentation site served at `/docs`.
The webserver renders it at startup (`src/services/docs.ts`) and again whenever a file here changes, so edits show up on the next page load without a restart.

## Layout

```
documentation/
  sections.json            section order, titles, and which sections are public
  <section>/<slug>.md      one page, shown at /docs#/<section>/<slug>
```

A section with `"public": true` can be read without logging in. Every other section needs a logged-in account.

## Page format

Each page starts with frontmatter. `order` sorts pages inside their section (low first).

```md
---
title: Plugins
description: One sentence shown under the title and in search results.
order: 150
---

Opening paragraph. Do not repeat the title as a heading, the site renders it.

## First section

### A sub section
```

Rules:

- Use only `##` and `###` headings. They build the "On this page" outline.
- Link to other pages with `[Plugins](#/engine/plugins)` and to a heading with `[Engine API](#/engine/plugins/engine-api)`. The last part is the heading text in lower case with dashes.
- Tables with ten or more rows get a filter box automatically.
- Never put a URL path segment such as `console` or `.env` into a real link on this site, the reverse proxy blocks those.

## Code blocks

Always name the language. Supported: `ts`, `js`, `json`, `bash`, `sql`, `env`, `html`, `css`, `yaml`, `text`.
Add `title="..."` to show a file name or label.

````md
```ts title="src/plugins/example/index.ts"
export function register(engine: EngineAPI) {}
```
````

## Tabs

Wrap two or more code blocks. Each block's `title` becomes the tab label.

````md
:::tabs
```bash title="Development"
bun development
```
```bash title="Production"
bun production
```
:::
````

## Callouts

Types: `note`, `tip`, `warning`, `danger`. Text after the type is an optional title.

```md
:::warning Certificates are mandatory
WebTransport needs TLS even on localhost.
:::
```
