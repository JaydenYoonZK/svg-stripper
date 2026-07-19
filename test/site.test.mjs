import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(root, "docs");
const html = readFileSync(join(docs, "index.html"), "utf8");
const html404 = readFileSync(join(docs, "404.html"), "utf8");

test("every button and select has an accessible name", () => {
  for (const page of [html, html404]) {
    for (const match of page.matchAll(/<(button|select)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const hasLabel = /\baria-label="[^"]+"/.test(match[0].slice(0, match[0].indexOf(">") + 1));
      const visibleText = match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      assert.ok(hasLabel || visibleText.length > 0, `no accessible name: ${match[0].slice(0, 120)}`);
    }
  }
});

test("internal navigation targets exist", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const target of [...html.matchAll(/\bhref="#([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(ids.has(target), `missing #${target}`);
  }
});

test("local page assets exist", () => {
  for (const [page, file] of [[html, "index.html"], [html404, "404.html"]]) {
    const references = [...page.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    const local = references.filter((value) => !/^(?:[a-z]+:|#)/i.test(value) && !value.startsWith("//"));
    for (const reference of local) {
      const path = reference.replace(/^\/svg-stripper\//, "").split(/[?#]/, 1)[0];
      assert.ok(existsSync(join(docs, path)), `missing local asset in ${file}: ${reference}`);
    }
  }
});

test("security and structured metadata remain valid", () => {
  assert.match(html, /connect-src 'none'/);
  assert.match(html404, /connect-src 'none'/);
  const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(jsonLd, "missing JSON-LD metadata");
  assert.doesNotThrow(() => JSON.parse(jsonLd[1]));
  assert.match(html, /"@type": "SoftwareApplication"/);
});

test("the CSP script hash matches the inline script it authorizes", async () => {
  // script-src carries a hash instead of 'unsafe-inline'. If the theme-boot
  // script changes without this hash, the page loads unthemed and broken, so
  // the hash is recomputed here from the actual bytes.
  const { createHash } = await import("node:crypto");
  for (const [page, file] of [[html, "index.html"], [html404, "404.html"]]) {
    const declared = page.match(/script-src [^;]*'sha256-([^']+)'/);
    assert.ok(declared, `${file}: script-src must authorize the inline script by hash, not 'unsafe-inline'`);
    assert.doesNotMatch(page.match(/script-src [^;]*/)[0], /'unsafe-inline'/, `${file}: script-src must not fall back to 'unsafe-inline'`);
    const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(inline.length, 1, `${file}: exactly one inline script is expected`);
    const actual = createHash("sha256").update(inline[0], "utf8").digest("base64");
    assert.equal(declared[1], actual, `${file}: CSP hash is stale; recompute sha256 of the inline script`);
  }
});

test("search and social metadata point to the canonical site", () => {
  const robots = readFileSync(join(docs, "robots.txt"), "utf8");
  const sitemap = readFileSync(join(docs, "sitemap.xml"), "utf8");
  assert.match(robots, /Sitemap: https:\/\/jaydenyoonzk\.github\.io\/svg-stripper\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/jaydenyoonzk\.github\.io\/svg-stripper\/<\/loc>/);
  assert.match(html, /<meta property="og:image:alt" content="[^"]+">/);
  assert.match(html, /<meta property="og:image:width" content="1280">/);
  assert.match(html, /<meta name="twitter:description" content="[^"]+">/);
});

test("the shared version is consistent across the shell", () => {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const sw = readFileSync(join(docs, "sw.js"), "utf8");
  assert.match(html, new RegExp(`styles\\.css\\?v=${version.replace(/\./g, "\\.")}`), "index stylesheet version drifted");
  assert.match(html, new RegExp(`"softwareVersion": "${version.replace(/\./g, "\\.")}"`), "JSON-LD softwareVersion drifted");
  assert.match(sw, new RegExp(`VERSION = "\\?v=${version.replace(/\./g, "\\.")}"`), "service worker version drifted");
});
