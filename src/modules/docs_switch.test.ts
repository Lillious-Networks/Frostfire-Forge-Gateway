import { expect, test } from "bun:test";
import { isDocsPath, withoutDocsLinks } from "./docs_switch";

test("the Docs link is taken out of a page and the other links stay; only the documentation's paths are its paths", async () => {
  const page = '<nav><a class="site-link" href="/docs">Docs</a><a class="site-link" href="/registration">Register</a></nav>';
  expect(await withoutDocsLinks(new Response(page)).text()).toBe('<nav><a class="site-link" href="/registration">Register</a></nav>');
  expect(["/docs", "/docs/", "/api/docs", "/", "/documents", "/api/docs2"].map(isDocsPath)).toEqual([true, true, true, false, false, false]);
});
