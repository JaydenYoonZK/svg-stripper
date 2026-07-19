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

// A minimal reference parser for path data, used to check that whatever bytes
// the optimizer emits still mean the same drawing commands. Arc flags are
// single characters per the grammar, never part of a number.
function parsePathSegs(d) {
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  const segs = [];
  let i = 0, cmd = null;
  const ws = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = () => {
    ws(); const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) return null; i += m[0].length; return parseFloat(m[0]);
  };
  const flag = () => { ws(); if (d[i] === "0" || d[i] === "1") return Number(d[i++]); return null; };
  while (i < d.length) {
    ws(); if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    const lower = cmd.toLowerCase();
    if (lower === "z") { segs.push({ cmd, args: [] }); continue; }
    const args = [];
    for (let k = 0; k < ARGS[lower]; k++) {
      const v = lower === "a" && (k === 3 || k === 4) ? flag() : num();
      if (v == null) return segs;
      args.push(v);
    }
    segs.push({ cmd, args });
    if (lower === "m") cmd = cmd === "M" ? "L" : "l";
  }
  return segs;
}

test("arc flags are never merged into coordinates", () => {
  // "a5 5 0 015 5" packs large-arc-flag 0 and sweep-flag 1 with no separators.
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M2 2a5 5 0 015 5"/></svg>`);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  const arc = parsePathSegs(d).find((s) => s.cmd.toLowerCase() === "a");
  assert.ok(arc, "the arc segment must survive");
  assert.deepEqual(arc.args, [5, 5, 0, 0, 1, 5, 5], "radii, rotation, both flags, and the end point are unchanged");
});

/* ---- the shortest-encoding path emitter ---- */

// End point of every segment, resolved to absolute coordinates: the ground
// truth a renderer traces. Two path strings that produce the same list draw
// the same outline (curve controls are asserted separately).
function tracePoints(d) {
  const pts = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const { cmd, args } of parsePathSegs(d)) {
    const rel = cmd === cmd.toLowerCase();
    const lower = cmd.toLowerCase();
    if (lower === "z") { cx = sx; cy = sy; pts.push([cx, cy]); continue; }
    let x = cx, y = cy;
    if (lower === "h") x = rel ? cx + args[0] : args[0];
    else if (lower === "v") y = rel ? cy + args[0] : args[0];
    else { const k = args.length; x = rel ? cx + args[k - 2] : args[k - 2]; y = rel ? cy + args[k - 1] : args[k - 1]; }
    if (lower === "m") { sx = x; sy = y; }
    cx = x; cy = y;
    pts.push([cx, cy]);
  }
  return pts;
}

test("path re-encoding never moves an end point", () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64 8 L96 24 L96 64 C96 90 82 112 64 118 C46 112 32 90 32 64 L32 24 Z M50 60 L60 70 L80 44"/></svg>`;
  const r = optimize(src);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  assert.deepEqual(tracePoints(d), tracePoints(/d="([^"]+)"/.exec(src)[1]));
});

test("axis-aligned lines become H and V, and curves become S when they reflect", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 C90 95 85 100 80 100 C75 100 70 95 70 90"/></svg>`);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  assert.match(d, /[hH]/, "the horizontal line should use H or h");
  assert.match(d, /[vV]/, "the vertical line should use V or v");
  assert.match(d, /[sS]/, "the reflecting cubic should use S or s");
  assert.doesNotMatch(d, /[hH][^\d-.]*[\d.-]+[^hHvV]*[vV]?.*C.*C/, "both cubics should not stay as C");
});

test("relative coordinates re-accumulate to the exact absolute positions", () => {
  // A long chain where every segment is shorter written relative. The traced
  // points must equal the absolute originals exactly at the kept precision.
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path d="M100.25 100.25 L110.5 110.5 L120.75 120.75 L131 131 L141.25 141.25"/></svg>`;
  const r = optimize(src);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  const got = tracePoints(d).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  assert.deepEqual(got, tracePoints(/d="([^"]+)"/.exec(src)[1]));
});

test("a tiny arc radius never rounds away to zero", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 50a0.004 0.004 0 0 1 20 0"/></svg>`, { precision: 2 });
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  const arc = parsePathSegs(d).find((s) => s.cmd.toLowerCase() === "a");
  assert.ok(arc.args[0] > 0 && arc.args[1] > 0, "radii must stay nonzero so the arc stays an arc");
});

/* ---- the new byte-shaving passes ---- */

test("style declarations move to attributes when no stylesheet remains", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect style="fill:#FFFFFF;stroke-width:3" width="10" height="10"/></svg>`);
  assert.doesNotMatch(r.svg, /style=/, "the style attribute should be gone");
  assert.match(r.svg, /fill="#fff"/, "the moved fill is then shortened too");
  assert.match(r.svg, /stroke-width="3"/);
});

test("style declarations stay put while a stylesheet survives", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@media(min-width:1px){.a{fill:#000}}</style><rect class="a" style="stroke:#ff0000" width="10" height="10"/></svg>`);
  assert.match(r.svg, /style="stroke:#f00"/, "with CSS in play the declaration must keep its priority");
});

test("a style declaration the attribute form cannot express is kept", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect style="fill:#000;transform:translate(1px)" width="10" height="10"/></svg>`);
  assert.match(r.svg, /fill="#000"/, "the expressible part moves");
  assert.match(r.svg, /style="transform:translate\(1px\)"/, "the CSS-only part stays inline");
});

test("identity transforms are dropped and a translation matrix is rewritten", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g transform="translate(0,0)"><rect width="10" height="10"/></g><rect transform="matrix(1,0,0,1,3,4)" width="1" height="1"/><rect transform="rotate(45)" width="1" height="1"/></svg>`);
  assert.doesNotMatch(r.svg, /translate\(0/, "an identity translate is noise");
  assert.match(r.svg, /transform="translate\(3 4\)"/, "a pure translation matrix reads shorter as translate");
  assert.match(r.svg, /rotate\(45\)/, "a real rotation is untouched");
  assert.doesNotMatch(r.svg, /<g/, "the group that held only the identity transform unwraps");
});

test("xlink:href becomes href and the xlink namespace goes with it", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/><use xlink:href="#g"/></svg>`);
  assert.match(r.svg, /<use href="#g"/, "the modern spelling is shorter");
  assert.doesNotMatch(r.svg, /xmlns:xlink/, "the namespace declaration is then dead weight");
});

test("a bare defs around only definitions unwraps, one with a shape does not", () => {
  const defsOnly = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/></svg>`);
  assert.doesNotMatch(defsOnly.svg, /<defs/, "a gradient renders by reference from anywhere");
  assert.match(defsOnly.svg, /<linearGradient id="g"/, "the gradient itself must survive");
  const withShape = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><rect id="r" width="5" height="5"/></defs><use href="#r"/></svg>`);
  assert.match(withShape.svg, /<defs/, "a shape inside defs must stay hidden inside defs");
});

test("a number after z does not hang the parser", () => {
  // "z0" is a path grammar error. The old tokenizer spun forever on it,
  // which froze the page on a paste. It must now truncate like a renderer.
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h5v5z0 0h9"/></svg>`);
  assert.ok(r.ok);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  assert.match(d, /z$/i, "everything after the stray number is dropped");
  assert.equal(optimize(r.svg).svg, r.svg);
});

test("non-finite and absurd coordinates truncate the path instead of corrupting it", () => {
  for (const bad of ["M0 0L1e309 5", "M0 0L5 e59", "M0 0L9e31 1", "M0 0L5e 5"]) {
    const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="${bad}h3"/></svg>`);
    assert.ok(r.ok, bad);
    const d = /d="([^"]*)"/.exec(r.svg)[1];
    assert.doesNotMatch(d, /[iI]nfinity|NaN|e\+/, `${bad} must not leak a non-numeric token`);
    assert.equal(optimize(r.svg).svg, r.svg, `${bad} must stay idempotent`);
  }
});

test("a large many-path document optimizes in linear time", () => {
  let big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048">`;
  for (let k = 0; k < 1000; k++) big += `<path fill="#abc" d="M${k} ${k}l10.123456 5.654321L${k + 30} ${k + 8}Z"/>`;
  big += "</svg>";
  const t0 = performance.now();
  const r = optimize(big);
  const took = performance.now() - t0;
  assert.ok(r.ok);
  assert.ok(took < 2000, `took ${took.toFixed(0)}ms; the parser must stay linear`);
});

test("points and viewBox keep separators every SVG engine accepts", () => {
  // The glued "90-30" spelling is only grammatical inside path data. Gecko
  // rejects it in attribute number lists, discarding the whole attribute.
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="10, 10 50, 90 -30, 40"/></svg>`);
  const pts = /points="([^"]+)"/.exec(r.svg)[1];
  assert.ok(/[\s,]/.test(pts.slice(1)), "numbers stay separated");
  assert.doesNotMatch(pts, /\d-/, "no negative number glued to the one before it");
  const vb = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 1 1"><rect width="1" height="1"/></svg>`);
  const vbv = /viewBox="([^"]+)"/.exec(vb.svg)[1];
  assert.equal((vbv.match(/[\s,]+/g) || []).length, 3, "viewBox keeps all three separators");
});

/* ---- regression tests from the adversarial engine review ---- */

test("huge finite coordinates pass through untouched instead of being deleted", () => {
  // Browsers render 1e13; deleting it would erase a visible stroke.
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path stroke="red" fill="none" d="M0 50 L1e13 50 L50 50"/></svg>`;
  const r = optimize(src);
  const d = /d="([^"]+)"/.exec(r.svg)[1];
  assert.deepEqual(tracePoints(d), [[0, 50], [1e13, 50], [50, 50]], "every end point survives exactly");
  assert.equal(optimize(r.svg).svg, r.svg, "re-optimizing changes nothing");
  // and one past the exact range: the whole d passes through byte-for-byte
  const far = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 50 L9e15 50 L50 50"/></svg>`;
  const rf = optimize(far);
  assert.match(rf.svg, /d="M0 50 L9e15 50 L50 50"/, "beyond the exact range the input is handed back untouched");
});

test("garbage in path data truncates the way a renderer truncates", () => {
  // an unknown command letter: nothing after it may render
  const unknown = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0 X9 9 L50 50"/></svg>`);
  assert.doesNotMatch(/d="([^"]*)"/.exec(unknown.svg)[1], /50/, "segments after an unknown command are gone");
  // junk before the first command: the whole path is in error
  const junkFirst = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="5 M0 0 L50 50"/></svg>`);
  assert.equal(/d="([^"]*)"/.exec(junkFirst.svg)[1], "", "a path that does not begin with a command renders nothing");
});

test("style attributes inside foreignObject are left alone", () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml" style="display:none;fill:red">hidden</div></foreignObject></svg>`;
  const r = optimize(src);
  assert.match(r.svg, /style="display:none;fill:red"/, "HTML style declarations are not this engine's to move");
});

test("CSS comments in a stylesheet do not become attribute names", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{/* brand */fill:#123456}</style><rect class="a" width="10" height="10"/></svg>`);
  assert.match(r.svg, /fill="#123456"/, "the declaration survives the comment");
  assert.doesNotMatch(r.svg, /\/\*|\*\//, "no comment fragment leaks into the markup");
});

test("a print-only stylesheet is never inlined into screen rendering", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style media="print">.a{fill:#000}</style><rect class="a" fill="#f00" width="10" height="10"/></svg>`);
  assert.match(r.svg, /<style media="print"/, "the media-scoped sheet must survive");
  assert.match(r.svg, /fill="#f00"/, "the screen rendering keeps the attribute value");
});

test("a prefixed svg:style stylesheet still counts as a stylesheet", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><svg:style>@media(min-width:1px){.a{fill:#000}}</svg:style><rect class="a" style="stroke:#ff0000" width="10" height="10"/></svg>`);
  assert.match(r.svg, /style="stroke:#f00"/, "declarations keep their cascade priority while any sheet lives");
});

test("a duplicated declaration stays inline to preserve last-valid-wins", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect style="fill:#f00;fill:hsl(bogus)" width="10" height="10"/></svg>`);
  assert.match(r.svg, /style="fill:#f00;fill:hsl\(bogus\)"/, "the engine cannot judge validity, so it must not choose");
});

test("an explicit default under an ancestor's style declaration is kept", () => {
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g style="stroke-width:3 !important"><rect stroke-width="1" stroke="#000" width="10" height="10"/></g></svg>`);
  assert.match(r.svg, /stroke-width="1"/, "dropping it would let the ancestor's 3 inherit through");
});

test("deep nesting degrades gracefully instead of overflowing the stack", () => {
  const deep = "<g>".repeat(5000) + '<rect width="1" height="1"/>' + "</g>".repeat(5000);
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${deep}</svg>`);
  assert.ok(r.ok, "a 5000-deep nest must not throw");
  assert.match(r.svg, /<rect/, "the shape survives");
});

test("hostile long transform and style attributes stay linear-time", () => {
  const hostileTransform = "a".repeat(200000);
  const hostileStyle = "url(".repeat(20000);
  const t0 = performance.now();
  const r = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g transform="${hostileTransform}"><rect style="${hostileStyle}" width="10" height="10"/></g></svg>`);
  const took = performance.now() - t0;
  assert.ok(r.ok);
  assert.ok(took < 2000, `took ${took.toFixed(0)}ms; hostile attributes must not go quadratic`);
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
