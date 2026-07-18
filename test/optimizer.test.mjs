import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { optimize, byteLength, listPaints, applyRecolor } from "../docs/optimizer.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const corpus = JSON.parse(readFileSync(join(root, "test/fixtures/corpus.json"), "utf8"));

const idsOf = (svg) => new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
function refsOf(svg) {
  const refs = new Set();
  for (const m of svg.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) refs.add(m[1]);
  for (const m of svg.matchAll(/(?:xlink:href|href)="#([^"]+)"/g)) refs.add(m[1]);
  return refs;
}
const countTag = (svg, tag) => (svg.match(new RegExp(`<${tag}[\\s>/]`, "g")) || []).length;

/* ---- the corpus: real editor exports and adversarial cases ---- */

for (const f of corpus) {
  test(`corpus: ${f.name} optimizes without breaking the graphic`, () => {
    const r = optimize(f.svg);
    assert.ok(r.ok, `optimize failed: ${r.error}`);
    assert.ok(r.svg.includes("<svg"), "output lost its <svg> root");

    // Every reference in the output must still resolve. This is the single
    // most important guarantee: a dropped-but-referenced id is a broken image.
    const ids = idsOf(r.svg);
    for (const ref of refsOf(r.svg)) {
      assert.ok(ids.has(ref), `dangling reference #${ref} (its id was removed)`);
    }

    // Running it again changes nothing.
    assert.equal(optimize(r.svg).svg, r.svg, "not idempotent");

    // Output is never larger than input.
    assert.ok(r.after <= r.before, `grew from ${r.before} to ${r.after}`);
  });
}

test("animation elements and their motion-path ids are preserved", () => {
  for (const f of corpus.filter((x) => x.category === "smil-animation")) {
    const r = optimize(f.svg);
    for (const tag of ["animate", "animateTransform", "animateMotion", "mpath"]) {
      assert.equal(countTag(r.svg, tag), countTag(f.svg, tag), `${f.name}: ${tag} count changed`);
    }
  }
});

test("hostile SVG has scripts, handlers, and javascript: urls removed", () => {
  for (const f of corpus.filter((x) => x.category === "security-hostile")) {
    const r = optimize(f.svg);
    assert.doesNotMatch(r.svg, /<script[\s>]/, `${f.name}: <script> survived`);
    assert.doesNotMatch(r.svg, /\son\w+=/, `${f.name}: an on* handler survived`);
    assert.doesNotMatch(r.svg, /javascript:/i, `${f.name}: a javascript: url survived`);
    assert.ok(r.notes.some((n) => n.kind === "security"), `${f.name}: no security note reported`);
  }
});

test("text content and its whitespace are preserved byte for byte", () => {
  for (const f of corpus.filter((x) => x.category === "text-whitespace-preservation")) {
    const r = optimize(f.svg);
    const textOf = (s) => (s.match(/<text[\s\S]*?<\/text>/g) || []).join("").replace(/<[^>]+>/g, "");
    assert.equal(textOf(r.svg), textOf(f.svg), `${f.name}: rendered text changed`);
  }
});

/* ---- targeted unit tests ---- */

test("arc flags are never merged into coordinates", () => {
  // "a5 5 0 015 5" packs large-arc-flag 0 and sweep-flag 1 with no separators.
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M2 2a5 5 0 015 5"/></svg>`);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  // flags must remain two single digits, followed by the end point 5 5
  assert.match(d, /a5 5 0 0 1 5 5/);
});

test("coordinate precision is reduced to the requested places", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10.123456" y="9.999" width="80" height="80"/></svg>`, { precision: 2 });
  assert.match(r.svg, /x="10\.12"/);
  assert.match(r.svg, /y="10"/); // 9.999 rounds to 10
});

test("colors are shortened without changing them", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="#FFFFFF" stroke="rgb(255,0,0)"/></svg>`);
  assert.match(r.svg, /fill="#fff"/);
  assert.match(r.svg, /stroke="#f00"/);
});

test("a trivial Illustrator style block is inlined and the class dropped", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style type="text/css">.a{fill:#123456;}</style><rect class="a" width="10" height="10"/></svg>`);
  assert.doesNotMatch(r.svg, /<style/, "style block should be gone");
  assert.doesNotMatch(r.svg, /class=/, "class should be gone");
  assert.match(r.svg, /fill="#123456"/, "color should reach the shape");
});

test("a stylesheet with a media query or pseudo is left as a stylesheet", () => {
  const withMedia = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@media(min-width:1px){.a{fill:#000}}</style><rect class="a" width="10" height="10"/></svg>`);
  assert.match(withMedia.svg, /<style/, "must not inline a stylesheet it cannot fully model");
  const withPseudo = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a:hover{fill:#000}</style><rect class="a" width="10" height="10"/></svg>`);
  assert.match(withPseudo.svg, /<style/, "a pseudo-class rule must not be inlined");
});

test("comments, metadata, and editor namespaces are removed", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="x" viewBox="0 0 1 1"><!-- Generator --><metadata>junk</metadata><sodipodi:namedview id="v"/><rect sodipodi:role="line" width="1" height="1"/></svg>`);
  assert.doesNotMatch(r.svg, /<!--/);
  assert.doesNotMatch(r.svg, /metadata/);
  assert.doesNotMatch(r.svg, /sodipodi/);
});

test("empty groups collapse and attribute-less groups unwrap", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g></g><g><rect width="1" height="1"/></g></svg>`);
  assert.doesNotMatch(r.svg, /<g/, "no group should remain");
  assert.match(r.svg, /<rect/, "the shape must survive the unwrap");
});

test("a group carrying a transform or opacity is never unwrapped", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g opacity="0.5"><rect width="10" height="10"/></g></svg>`);
  assert.match(r.svg, /<g opacity=/, "the group's opacity must be kept, so the group stays");
});

test("default presentation attributes are dropped, non-defaults kept", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill-opacity="1" fill-rule="evenodd" stroke-width="1.0"/></svg>`);
  assert.doesNotMatch(r.svg, /fill-opacity/, "fill-opacity=1 is the default");
  assert.doesNotMatch(r.svg, /stroke-width/, "stroke-width=1.0 normalizes to the default and drops");
  assert.match(r.svg, /fill-rule="evenodd"/, "evenodd is NOT the default and must stay");
});

test("an id referenced only from a surviving stylesheet is kept", () => {
  // The @media rule means the stylesheet cannot be inlined, so it survives.
  // The gradient id it names via url(#g) must not be removed as unreferenced.
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@media(min-width:1px){.a{fill:url(#g)}}</style><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect class="a" width="10" height="10"/></svg>`);
  assert.match(r.svg, /id="g"/, "the referenced gradient id must survive");
  assert.doesNotMatch(r.svg.replace(/url\(#g\)/g, ""), /#g"/); // sanity: reference and def stay in sync
});

test("input without an <svg> element is rejected, not mangled", () => {
  const r = optimize("just some text, not svg");
  assert.equal(r.ok, false);
  assert.match(r.error, /svg/i);
});

test("pretty output is valid and re-minifies to the same bytes", () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><rect width="10" height="10" fill="#abc"/></g></svg>`;
  const pretty = optimize(src, { prettify: true });
  assert.ok(pretty.svg.includes("\n"), "pretty output should have newlines");
  const reMin = optimize(pretty.svg, { prettify: false });
  const min = optimize(src, { prettify: false });
  assert.equal(reMin.svg, min.svg, "pretty then minify equals a direct minify");
});

/* ---- regression tests for the reviewed bugs ---- */

test("entity references in text and attributes are not double-escaped", () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text aria-label="&#169; 2026 &amp; co">Tom &amp; Jerry &#169; &#8364;</text></svg>`;
  const r = optimize(src);
  assert.doesNotMatch(r.svg, /&amp;amp;/, "an existing &amp; must not become &amp;amp;");
  assert.doesNotMatch(r.svg, /&amp;#169;/, "a numeric reference must survive intact");
  assert.match(r.svg, /Tom &amp; Jerry &#169; &#8364;/);
  assert.equal(optimize(r.svg).svg, r.svg, "entity handling must be idempotent");
});

test("a multi-class element keeps its stylesheet instead of losing its styling", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:red}.b{stroke:blue;stroke-width:2}</style><rect class="a" width="10" height="10"/><rect class="a b" width="4" height="4"/></svg>`);
  assert.match(r.svg, /<style/, "a multi-class usage means the sheet must stay");
  assert.match(r.svg, /class="a b"/, "the multi-class element keeps its class");
});

test("a class rule wins over a conflicting presentation attribute", () => {
  // original renders red (class beats presentation attribute); output must too
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:red}</style><rect class="a" fill="blue" width="10" height="10"/></svg>`);
  assert.match(r.svg, /fill="red"/, "the class value must win");
  assert.doesNotMatch(r.svg, /fill="blue"/);
});

test("an !important stylesheet is left intact", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:#123456!important}</style><rect class="a" width="10" height="10"/></svg>`);
  assert.match(r.svg, /<style/, "an !important value cannot be safely inlined");
});

test("a default value overriding an ancestor's non-default is kept", () => {
  // the group sets stroke-width 4; the rect resets to the default 1. Dropping
  // the rect's 1 would let it inherit 4.
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g stroke-width="4"><rect stroke-width="1" width="10" height="10"/></g></svg>`);
  assert.match(r.svg, /<rect stroke-width="1"/, "the overriding default must be kept");
});

test("uppercase and namespaced script elements are removed", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><SCRIPT>alert(1)</SCRIPT><svg:script>alert(2)</svg:script><rect width="10" height="10"/></svg>`);
  assert.doesNotMatch(r.svg, /script/i, "no script element in any case survives");
});

test("an id referenced by aria-labelledby is kept", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" aria-labelledby="t"><title id="t">A label</title><rect width="10" height="10"/></svg>`);
  assert.match(r.svg, /id="t"/, "the aria-referenced id must survive");
});

test("a javascript: url hidden with whitespace or entities is still removed", () => {
  const withTab = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a href="java&#9;script:alert(1)"><rect width="4" height="4"/></a></svg>`);
  assert.doesNotMatch(withTab.svg, /alert/, "a control-char-split javascript: url must be stripped");
  const withEntity = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a href="&#106;avascript:alert(1)"><rect width="4" height="4"/></a></svg>`);
  assert.doesNotMatch(withEntity.svg, /alert/, "an entity-encoded javascript: url must be stripped");
});

test("precision is raised on a tiny viewBox so geometry is not distorted", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0.123456 0.654321L0.987654 0.111111"/></svg>`, { precision: 2 });
  assert.match(r.svg, /\.123/, "on a unit viewBox, coordinates keep more than 2 places (leading zero is dropped)");
});

test("a nonzero dimension never rounds down to zero", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle r="0.004" cx="50" cy="50"/><line stroke-width="0.004" x1="0" y1="0" x2="10" y2="10"/></svg>`, { precision: 2 });
  assert.doesNotMatch(r.svg, /\br="0"/, "a nonzero radius must not become 0");
  assert.doesNotMatch(r.svg, /stroke-width="0"/, "a nonzero stroke-width must not become 0");
});

/* ---- color editing ---- */

test("listPaints enumerates distinct solid colors and gradient stops", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#66564f"/><stop offset="1" stop-color="#2b2d2d"/></linearGradient></defs><rect fill="#fff" width="10" height="10"/><circle fill="#fff" cx="5" cy="5" r="2"/><path fill="url(#g)" d="M0 0h4v4H0z"/></svg>`;
  const paints = listPaints(svg);
  const white = paints.colors.find((c) => c.value === "#fff");
  assert.ok(white, "the white fill should be listed");
  assert.equal(white.uses, 2, "both white parts count toward one swatch");
  assert.ok(!paints.colors.some((c) => c.value.startsWith("url(")), "a gradient fill is not a solid color");
  assert.equal(paints.gradients.length, 1);
  assert.equal(paints.gradients[0].stops.length, 2);
  assert.equal(paints.gradients[0].stops[0].color, "#66564f");
});

test("applyRecolor recolors a solid color and a gradient stop without breaking references", () => {
  const svg = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="#fff" width="10" height="10"/><path fill="url(#g)" d="M0 0h4v4H0z"/></svg>`).svg;
  const out = applyRecolor(svg, { "#fff": "#f00", "grad:g:0": "#00f" });
  assert.match(out, /fill="#f00"/, "the solid color changed");
  assert.match(out, /stop-color="#00f"/, "the gradient stop changed");
  assert.match(out, /fill="url\(#g\)"/, "the gradient reference is intact");
  assert.match(out, /id="g"/, "the gradient id survives");
});

test("a style fill shadows the attribute fill in the color list", () => {
  const paints = listPaints(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="#f00" style="fill:#00f" width="10" height="10"/></svg>`);
  const vals = paints.colors.map((c) => c.value);
  assert.ok(vals.includes("#00f"), "the winning inline-style color is listed");
  assert.ok(!vals.includes("#f00"), "the shadowed attribute color is not listed");
});

test("applyRecolor with no changes returns the input untouched", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="#fff" width="10" height="10"/></svg>`;
  assert.equal(applyRecolor(svg, {}), svg);
});

test("byteLength counts UTF-8 bytes, not code units", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2); // é is two bytes in UTF-8
  assert.equal(byteLength("💃"), 4); // 💃 is four bytes
});
