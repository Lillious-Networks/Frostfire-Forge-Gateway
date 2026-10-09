import { expect, test } from "bun:test";
import { brandHtml, cleanBrandName } from "./branding";

const PAGE = `<!doctype html><html lang="en"><head>
<link rel="icon" type="image/ico" href="./favicon-abc.ico">
<title>Frostfire Forge - Register</title></head><body>
<a class="site-brand" href="/" aria-label="Frostfire Forge home"><img src="./logo-abc.png" alt=""><span class="site-brand-name">Frostfire Forge</span></a>
<p class="register-subtitle">Join Frostfire Forge and begin your adventure</p>
<div class="loading-brand"><img src="./logo-abc.png"><span>Frostfire Forge</span></div>
<p>Frostfire Forge stays in body text</p>
</body></html>`;

test("cleanBrandName trims, flattens control characters and caps at 40", () => {
  expect(cleanBrandName(undefined)).toBe("");
  expect(cleanBrandName("   ")).toBe("");
  expect(cleanBrandName("  Moon Realm \n")).toBe("Moon Realm");
  expect(cleanBrandName("a\nb")).toBe("a b");
  expect(cleanBrandName("x".repeat(60))).toBe("x".repeat(40));
});

test("brandHtml swaps the name, escapes it, and leaves the images alone", async () => {
  const name = `<b>"Moon" & $& Realm`;
  const html = await brandHtml(new Response(PAGE), name).text();

  expect(html).toContain("<title>&lt;b&gt;\"Moon\" &amp; $&amp; Realm - Register</title>");
  expect(html).toContain(`<span class="site-brand-name">&lt;b&gt;"Moon" &amp; $&amp; Realm</span>`);
  expect(html).toContain(`aria-label="&lt;b&gt;&quot;Moon&quot; &amp; $&amp; Realm home"`);
  expect(html).toContain(`<html lang="en" data-brand-name="&lt;b&gt;&quot;Moon&quot; &amp; $&amp; Realm">`);
  expect(html).toContain("Join &lt;b&gt;");
  expect(html).toContain(`<div class="loading-brand"><img src="./logo-abc.png"><span>&lt;b&gt;`);
  expect(html).toContain(`href="./favicon-abc.ico"`);
  expect(html).not.toContain("<b>");
  expect(html).toContain("<p>Frostfire Forge stays in body text</p>");
});

test("brandHtml without a name leaves the page as it was", async () => {
  expect(await brandHtml(new Response(PAGE), "").text()).toBe(PAGE);
});
