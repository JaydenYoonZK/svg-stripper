/*! SVG Stripper | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/svg-stripper */
/* The engine. A small, dependency-free SVG optimizer that runs the same in a
   browser and in Node. It parses the markup into a tree, runs a series of
   honest transforms over it, and serializes it back. Every pass is
   conservative: when a change could alter what the picture looks like, it is
   not made. The reference-aware id pass, the text-whitespace guard, and the
   arc-flag-aware path parser are the three places where a naive optimizer
   quietly breaks a graphic, so they get the most care here. */

export const DEFAULTS = {
  precision: 2,          // decimal places kept in coordinates and path data
  transformPrecision: 5, // transforms carry rotations and matrices; keep more
  prettify: false,       // false minifies, true indents for reading
  removeComments: true,
  removeMetadata: true,  // <metadata>, editor namespaces, RDF
  removeEditorData: true,// sodipodi/inkscape/Illustrator attributes and ids
  removeTitleDesc: false,// kept by default: they are accessibility text
  removeScripts: true,   // <script>, on* handlers, javascript: urls
  shortenColors: true,
  collapseGroups: true,
  removeUnreferencedIds: true,
  inlineStyles: true,    // fold a trivial Illustrator <style> into attributes
  multipass: true,
};

// Elements whose text content is meaningful. Whitespace inside them is never
// collapsed and they are never re-indented, or the rendered words would move.
// Stored lowercase; membership is always tested case-insensitively.
const TEXT_CONTENT = new Set(["text", "tspan", "textpath", "tref", "title", "desc", "style", "script"]);
const isTextContent = (name) => TEXT_CONTENT.has(name.toLowerCase());

// Attributes that hold a color. url(#id), none, and currentColor pass through
// untouched; only literal colors are shortened.
const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color", "color", "flood-color", "lighting-color"]);

// Single-number geometry attributes safe to round to `precision`.
const NUM_ATTRS = new Set([
  "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry",
  "x1", "y1", "x2", "y2", "fx", "fy", "offset", "opacity",
  "fill-opacity", "stroke-opacity", "stop-opacity", "flood-opacity",
  "stroke-width", "stroke-dashoffset", "stroke-miterlimit", "font-size",
]);

// Attributes where rounding a nonzero value down to 0 would make the shape
// vanish (a zero stroke is not painted; a zero radius draws nothing).
const DIMENSION_ATTRS = new Set(["stroke-width", "r", "rx", "ry", "width", "height"]);

// Attributes holding a whitespace/comma separated list of numbers.
const NUMLIST_ATTRS = new Set(["points", "stroke-dasharray", "viewBox"]);
const TRANSFORM_ATTRS = new Set(["transform", "gradientTransform", "patternTransform"]);

// Presentation attributes that equal their SVG default and can be dropped.
const DEFAULT_ATTRS = {
  opacity: "1", "fill-opacity": "1", "stroke-opacity": "1", "stop-opacity": "1",
  "flood-opacity": "1", "stroke-width": "1", "fill-rule": "nonzero",
  "clip-rule": "nonzero", "stroke-linecap": "butt", "stroke-linejoin": "miter",
  "stroke-miterlimit": "4", "stroke-dashoffset": "0",
};

// Of the defaults above, these are inherited properties. For an inherited one,
// an explicit attribute equal to the initial value is the only thing overriding
// a non-default value set by an ancestor, so it may only be dropped when no
// ancestor sets that property to a non-default value.
const INHERITED_DEFAULTS = new Set([
  "fill-opacity", "stroke-opacity", "stroke-width", "fill-rule", "clip-rule",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dashoffset",
]);

// Editor namespace prefixes. Anything in these is authoring metadata.
const EDITOR_PREFIXES = ["sodipodi", "inkscape", "adobe", "i", "rdf", "cc", "dc", "graph"];

// Style properties whose presentation attribute takes the identical value
// syntax, so a declaration can move out of a style attribute losslessly once
// no stylesheet remains to compete with it. Shorthands and properties with
// CSS-only syntax (transform, mask, font) stay where they are.
const STYLE_TO_ATTR = new Set([
  "fill", "stroke", "stop-color", "flood-color", "lighting-color", "color",
  "opacity", "fill-opacity", "stroke-opacity", "stop-opacity", "flood-opacity",
  "fill-rule", "clip-rule", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "display", "visibility", "paint-order",
]);

// Definition-only elements: never rendered directly, only by reference, so a
// bare <defs> wrapper around exclusively these adds nothing but bytes.
const NEVER_RENDERED = new Set([
  "lineargradient", "radialgradient", "pattern", "symbol", "marker",
  "filter", "clippath", "mask",
]);

const NAMED_COLORS = {
  white: "#fff", black: "#000", red: "#f00", lime: "#0f0", blue: "#00f",
  aqua: "#0ff", cyan: "#0ff", fuchsia: "#f0f", magenta: "#f0f", yellow: "#ff0",
};

/* ---------- parser ---------- */

function parse(input) {
  let i = 0;
  const n = input.length;
  const root = { type: "root", children: [] };
  const stack = [root];
  const errors = [];
  const top = () => stack[stack.length - 1];

  while (i < n) {
    if (input[i] === "<") {
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i + 4);
        const stop = end === -1 ? n : end;
        top().children.push({ type: "comment", value: input.slice(i + 4, stop) });
        i = end === -1 ? n : end + 3;
      } else if (input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf("]]>", i + 9);
        const stop = end === -1 ? n : end;
        top().children.push({ type: "cdata", value: input.slice(i + 9, stop) });
        i = end === -1 ? n : end + 3;
      } else if (input.startsWith("<!", i)) {
        let j = i + 2, depth = 0;
        for (; j < n; j++) {
          if (input[j] === "[") depth++;
          else if (input[j] === "]") depth--;
          else if (input[j] === ">" && depth <= 0) break;
        }
        top().children.push({ type: "doctype", raw: input.slice(i, j + 1) });
        i = j + 1;
      } else if (input.startsWith("<?", i)) {
        const end = input.indexOf("?>", i + 2);
        const raw = input.slice(i, end === -1 ? n : end + 2);
        top().children.push({ type: /^<\?xml\s/i.test(raw) ? "decl" : "pi", raw });
        i = end === -1 ? n : end + 2;
      } else if (input[i + 1] === "/") {
        const end = input.indexOf(">", i);
        const stop = end === -1 ? n : end;
        const name = input.slice(i + 2, stop).trim();
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].name === name) { stack.length = s; break; }
        }
        i = end === -1 ? n : end + 1;
      } else {
        const parsed = parseTag(input, i);
        if (!parsed) { errors.push("bad tag at " + i); i++; continue; }
        const el = { type: "element", name: parsed.name, attrs: parsed.attrs, children: [] };
        top().children.push(el);
        // Every later stage recurses over this tree; a hostile file nested
        // thousands of elements deep would blow their stack. No real artwork
        // is a thousand groups deep, so beyond that, further tags are kept as
        // leaves rather than nested.
        if (!parsed.selfClose) {
          if (stack.length < 1024) stack.push(el);
          else errors.push("nesting depth limit at " + i);
        }
        i = parsed.end;
      }
    } else {
      const next = input.indexOf("<", i);
      const stop = next === -1 ? n : next;
      top().children.push({ type: "text", value: input.slice(i, stop) });
      i = stop;
    }
  }
  return { root, errors };
}

// Character-scanned, no per-position copies of the remaining input: on a large
// file the slice-per-attribute approach turns linear parsing into gigabytes of
// temporary strings. Only the final names and values are ever sliced out.
const WS = /\s/;
function parseTag(input, start) {
  let i = start + 1;
  const n = input.length;
  let j = i;
  while (j < n && !WS.test(input[j]) && input[j] !== "/" && input[j] !== ">") j++;
  if (j === i) return null;
  const name = input.slice(i, j);
  i = j;
  const attrs = [];
  while (i < n) {
    while (i < n && WS.test(input[i])) i++;
    if (input[i] === ">") return { name, attrs, selfClose: false, end: i + 1 };
    if (input[i] === "/" && input[i + 1] === ">") return { name, attrs, selfClose: true, end: i + 2 };
    j = i;
    while (j < n && !WS.test(input[j]) && input[j] !== "=" && input[j] !== "/" && input[j] !== ">") j++;
    if (j === i) { i++; continue; }
    const aname = input.slice(i, j);
    i = j;
    while (i < n && WS.test(input[i])) i++;
    if (input[i] === "=") {
      i++;
      while (i < n && WS.test(input[i])) i++;
      const q = input[i];
      if (q === '"' || q === "'") {
        const end = input.indexOf(q, i + 1);
        const stop = end === -1 ? n : end;
        attrs.push({ name: aname, value: decodeEntities(input.slice(i + 1, stop)), quote: '"' });
        i = end === -1 ? n : end + 1;
      } else {
        j = i;
        while (j < n && !WS.test(input[j]) && input[j] !== "/" && input[j] !== ">") j++;
        attrs.push({ name: aname, value: input.slice(i, j), quote: '"' });
        i = j;
      }
    } else {
      attrs.push({ name: aname, value: null, quote: '"' });
    }
  }
  return { name, attrs, selfClose: false, end: n };
}

function decodeEntities(s) {
  // Only the five XML predefined entities are decoded; numeric and other named
  // references are left exactly as written and preserved through serialization.
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) =>
    ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e]));
}

/* ---------- reference scan ---------- */

function collectReferences(root) {
  const refs = new Set();
  const urlRe = /url\(\s*['"]?#([^'")\s]+)/g;
  const addUrls = (text) => {
    if (!text) return;
    let m;
    urlRe.lastIndex = 0;
    while ((m = urlRe.exec(text))) refs.add(m[1]);
  };
  walk(root, (node) => {
    if (node.type !== "element") return;
    // A stylesheet or script that survives can reference ids by url(#id), so
    // its text counts too, not just element attributes.
    if (isTextContent(node.name) && (node.name.toLowerCase().endsWith("style") || node.name.toLowerCase().endsWith("script"))) {
      addUrls((node.children || []).map((c) => (c.type === "text" || c.type === "cdata") ? c.value : "").join(""));
    }
    for (const a of node.attrs) {
      if (a.value == null) continue;
      addUrls(a.value);
      if ((a.name === "href" || a.name === "xlink:href") && a.value.startsWith("#")) {
        refs.add(a.value.slice(1));
      }
      // aria-labelledby / aria-describedby reference ids as a space-separated
      // list, without a '#'. Keeping <title>/<desc> is pointless if the id that
      // links them to a shape is stripped.
      if (a.name === "aria-labelledby" || a.name === "aria-describedby") {
        for (const id of a.value.split(/\s+/)) if (id) refs.add(id);
      }
      // SMIL timing: begin/end can name another element's events.
      if (a.name === "begin" || a.name === "end") {
        for (const part of a.value.split(";")) {
          const id = part.trim().split(".")[0];
          if (id && !/^[\d+-]/.test(id) && !["indefinite", "click", "mouseover", "mouseout"].includes(id)) refs.add(id);
        }
      }
    }
  });
  return refs;
}

function walk(node, fn) {
  fn(node);
  if (node.children) for (const c of node.children) walk(c, fn);
}

/* ---------- number and color formatting ---------- */

function fmtNum(value, precision) {
  if (!isFinite(value)) return String(value);
  let r = Number(value.toFixed(precision));
  if (Object.is(r, -0)) r = 0;
  let s = String(r);
  if (s.includes("e")) return String(value);
  s = s.replace(/^(-?)0\./, "$1.");
  return s;
}

// A dimension that is genuinely nonzero must not round to 0, or the shape
// disappears. Clamp to the smallest value the precision can represent instead.
function fmtNumDimension(value, precision) {
  const s = fmtNum(value, precision);
  if (value !== 0 && parseFloat(s) === 0) {
    const step = Math.pow(10, -precision);
    return fmtNum(value < 0 ? -step : step, precision);
  }
  return s;
}

const NUM_TOKEN = /-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function roundNumberList(value, precision) {
  return value.replace(NUM_TOKEN, (m) => fmtNum(parseFloat(m), precision));
}

// Drop transform functions that are exact identities and rewrite a plain
// translation or scale matrix into its shorter named form. Every rewrite here
// is an exact numeric identity on already-rounded values; anything the parser
// does not fully recognize is left byte-for-byte alone.
function simplifyTransform(value) {
  // A real transform list is short. An absurdly long or paren-free value is
  // left alone before any regex sees it, so a hostile attribute cannot drag
  // the guard regex into quadratic backtracking.
  if (value.length > 2000 || value.indexOf("(") === -1) return value;
  const fnRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  if (/[^\s,]/.test(value.replace(fnRe, ""))) return value;
  fnRe.lastIndex = 0;
  const out = [];
  let m;
  while ((m = fnRe.exec(value))) {
    const name = m[1];
    const raw = m[2].trim().split(/[\s,]+/).filter(Boolean);
    const a = raw.map(Number);
    if (a.some((x) => !isFinite(x))) return value;
    const emit = (nm, toks) => out.push(nm + "(" + toks.join(" ") + ")");
    if (name === "translate" && a.length >= 1 && a.length <= 2 && a.every((x) => x === 0)) continue;
    if (name === "scale" && a.length >= 1 && a.length <= 2 && a.every((x) => x === 1)) continue;
    if (name === "rotate" && (a.length === 1 || a.length === 3) && a[0] === 0) continue;
    if ((name === "skewX" || name === "skewY") && a.length === 1 && a[0] === 0) continue;
    if (name === "matrix" && a.length === 6) {
      if (a[0] === 1 && a[1] === 0 && a[2] === 0 && a[3] === 1) {
        if (a[4] === 0 && a[5] === 0) continue;
        emit("translate", a[5] === 0 ? [raw[4]] : [raw[4], raw[5]]);
        continue;
      }
      if (a[1] === 0 && a[2] === 0 && a[4] === 0 && a[5] === 0) {
        emit("scale", a[0] === a[3] ? [raw[0]] : [raw[0], raw[3]]);
        continue;
      }
    }
    if (name === "translate" && a.length === 2 && a[1] === 0) { emit("translate", [raw[0]]); continue; }
    if (name === "scale" && a.length === 2 && a[0] === a[1]) { emit("scale", [raw[0]]); continue; }
    emit(name, raw);
  }
  return out.join(" ");
}

function shortenColor(value) {
  const s = value.trim();
  let m = /^#([0-9a-fA-F]{6})$/.exec(s);
  if (m) {
    const h = m[1].toLowerCase();
    if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5]) return "#" + h[0] + h[2] + h[4];
    return "#" + h;
  }
  m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) return "#" + m[1].toLowerCase();
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(s);
  if (m) {
    const rgb = [m[1], m[2], m[3]].map(Number);
    if (rgb.every((x) => x <= 255)) {
      const hex = "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
      const short = shortenColor(hex);
      return short.length <= s.length ? short : s;
    }
  }
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named && named.length < s.length) return named;
  return s;
}

/* ---------- path data ---------- */

const PATH_ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

// Exact decimal string for an integer count of 10^-precision units. All path
// geometry below lives in this scaled-integer space, so deltas and reflection
// tests are exact and the relative form re-accumulates to the same absolute
// coordinates a renderer computes: byte-for-byte different, pixel identical.
function fmtUnits(u, precision) {
  if (u === 0) return "0";
  const neg = u < 0;
  let s = String(Math.abs(u));
  if (precision > 0) {
    s = s.padStart(precision + 1, "0");
    const ip = s.slice(0, -precision);
    const fp = s.slice(-precision).replace(/0+$/, "");
    s = fp ? ip + "." + fp : ip;
    if (s.startsWith("0.")) s = s.slice(1);
  }
  return neg ? "-" + s : s;
}

function optimizePath(d, precision) {
  const scale = Math.pow(10, precision);
  const U = (raw) => Math.round(parseFloat(raw) * scale);

  /* -- tokenize: commands with raw argument strings, arc flags kept apart -- */
  const rawSegs = [];
  let i = 0;
  const n = d.length;
  const ws = (ch) => ch === " " || ch === "," || ch === "\t" || ch === "\n" || ch === "\r";
  const readNumber = () => {
    while (i < n && ws(d[i])) i++;
    const start = i;
    let digits = 0;
    if (d[i] === "+" || d[i] === "-") i++;
    while (i < n && d[i] >= "0" && d[i] <= "9") { i++; digits++; }
    if (d[i] === ".") { i++; while (i < n && d[i] >= "0" && d[i] <= "9") { i++; digits++; } }
    if (digits === 0) { i = start; return null; } // a sign or dot alone is not a number
    if (d[i] === "e" || d[i] === "E") {
      // an exponent needs digits of its own. When they are missing, engines
      // keep the mantissa they already have and treat the stray "e" as the
      // next (unknown) command, which then truncates the rest. Mirror that.
      const back = i;
      i++;
      if (d[i] === "+" || d[i] === "-") i++;
      let exp = 0;
      while (i < n && d[i] >= "0" && d[i] <= "9") { i++; exp++; }
      if (exp === 0) { i = back; return d.slice(start, back); }
    }
    return d.slice(start, i);
  };
  const readFlag = () => {
    while (i < n && ws(d[i])) i++;
    const ch = d[i];
    if (ch === "0" || ch === "1") { i++; return ch; }
    return null;
  };
  let cmd = null;
  while (i < n) {
    while (i < n && ws(d[i])) i++;
    if (i >= n) break;
    const ch = d[i];
    let fromLetter = false;
    if (/[a-zA-Z]/.test(ch)) { cmd = ch; i++; fromLetter = true; }
    else if (cmd == null) break; // junk before the first command: the whole path is in error, render nothing
    const lower = (cmd || "").toLowerCase();
    if (lower === "z") {
      // z takes no arguments, so it only repeats via its own letter. A number
      // here is a grammar error; stop like a renderer instead of spinning on
      // the same character forever.
      if (fromLetter) { rawSegs.push({ cmd, args: [] }); continue; }
      break;
    }
    const count = PATH_ARGS[lower];
    if (count == null) break; // an unknown command letter truncates the path, exactly as a renderer does
    const args = [];
    let ok = true;
    for (let k = 0; k < count; k++) {
      if (lower === "a" && (k === 3 || k === 4)) {
        const f = readFlag();
        if (f == null) { ok = false; break; }
        args.push(f);
      } else {
        const num = readNumber();
        if (num == null) { ok = false; break; }
        args.push(num);
      }
    }
    if (!ok) break;
    rawSegs.push({ cmd, args });
    if (lower === "m") cmd = cmd === "M" ? "L" : "l";
  }

  /* -- normalize every segment to absolute unit-space geometry. H/V become L,
        S/T get their implicit control point resolved, so the emitter below can
        rediscover the shortest encoding for each from one canonical form. -- */
  const abs = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastCubic = null, lastQuad = null;
  for (const seg of rawSegs) {
    const lower = seg.cmd.toLowerCase();
    const rel = seg.cmd === lower;
    // A non-finite coordinate is a genuine parse-level error: renderers
    // reject the token and truncate the path there, and so does this.
    let sawNonFinite = false, sawHuge = false;
    const hugeBound = Number.MAX_SAFE_INTEGER / scale / 8;
    for (let k = 0; k < seg.args.length; k++) {
      if (lower === "a" && (k === 3 || k === 4)) continue;
      const v = parseFloat(seg.args[k]);
      if (!isFinite(v)) { sawNonFinite = true; break; }
      // Finite but beyond the exactly-representable scaled range: browsers
      // RENDER these, so nothing may be deleted. The whole path bails out of
      // the re-encoder instead (see the check after this loop).
      if (Math.abs(v) > hugeBound) sawHuge = true;
    }
    if (sawNonFinite) break;
    if (sawHuge) return d;
    const nx = (k) => rel ? cx + U(seg.args[k]) : U(seg.args[k]);
    const ny = (k) => rel ? cy + U(seg.args[k]) : U(seg.args[k]);
    switch (lower) {
      case "m": { const x = nx(0), y = ny(1); abs.push({ k: "M", x, y }); cx = sx = x; cy = sy = y; lastCubic = lastQuad = null; break; }
      case "l": { const x = nx(0), y = ny(1); abs.push({ k: "L", x, y }); cx = x; cy = y; lastCubic = lastQuad = null; break; }
      case "h": { const x = nx(0); abs.push({ k: "L", x, y: cy }); cx = x; lastCubic = lastQuad = null; break; }
      case "v": { const y = ny(0); abs.push({ k: "L", x: cx, y }); cy = y; lastCubic = lastQuad = null; break; }
      case "c": { const x1 = nx(0), y1 = ny(1), x2 = nx(2), y2 = ny(3), x = nx(4), y = ny(5);
        abs.push({ k: "C", x1, y1, x2, y2, x, y }); cx = x; cy = y; lastCubic = { x: x2, y: y2 }; lastQuad = null; break; }
      case "s": { const x1 = lastCubic ? 2 * cx - lastCubic.x : cx, y1 = lastCubic ? 2 * cy - lastCubic.y : cy;
        const x2 = nx(0), y2 = ny(1), x = nx(2), y = ny(3);
        abs.push({ k: "C", x1, y1, x2, y2, x, y }); cx = x; cy = y; lastCubic = { x: x2, y: y2 }; lastQuad = null; break; }
      case "q": { const x1 = nx(0), y1 = ny(1), x = nx(2), y = ny(3);
        abs.push({ k: "Q", x1, y1, x, y }); cx = x; cy = y; lastQuad = { x: x1, y: y1 }; lastCubic = null; break; }
      case "t": { const x1 = lastQuad ? 2 * cx - lastQuad.x : cx, y1 = lastQuad ? 2 * cy - lastQuad.y : cy;
        const x = nx(0), y = ny(1);
        abs.push({ k: "Q", x1, y1, x, y }); cx = x; cy = y; lastQuad = { x: x1, y: y1 }; lastCubic = null; break; }
      case "a": { const x = nx(5), y = ny(6);
        // radii are unsigned per spec; one that is genuinely nonzero must not
        // round away to 0, or the arc silently degrades into a straight line
        let rx = Math.abs(U(seg.args[0])), ry = Math.abs(U(seg.args[1]));
        if (rx === 0 && parseFloat(seg.args[0]) !== 0) rx = 1;
        if (ry === 0 && parseFloat(seg.args[1]) !== 0) ry = 1;
        abs.push({ k: "A", rx, ry, rot: fmtNum(parseFloat(seg.args[2]), precision), f1: seg.args[3], f2: seg.args[4], x, y });
        cx = x; cy = y; lastCubic = lastQuad = null; break; }
      case "z": { abs.push({ k: "Z" }); cx = sx; cy = sy; lastCubic = lastQuad = null; break; }
    }
    // Relative deltas can accumulate past the exactly-representable range even
    // when each one is modest. The moment any tracked coordinate leaves it,
    // exact re-encoding is off the table: hand back the input untouched.
    if (!Number.isSafeInteger(cx * 8) || !Number.isSafeInteger(cy * 8)) return d;
  }

  /* -- emit: for each segment try every equivalent encoding (absolute or
        relative; H/V for axis lines; S/T when the control point is the exact
        reflection) and keep the shortest, sharing the command letter with the
        previous segment where the grammar allows. -- */
  let out = "", state = null, prevTok = null, prevSeg = null;
  cx = 0; cy = 0; sx = 0; sy = 0;
  const N = (u) => ({ s: fmtUnits(u, precision), f: false });
  const R = (s) => ({ s, f: false });
  const FL = (ch) => ({ s: ch, f: true });
  const sepNeeded = (a, b) => {
    if (!a) return false;
    if (b.f) return !a.f;         // a flag after a number needs a space; after a flag none
    if (a.f) return false;        // a number can follow a flag directly
    return !(b.s[0] === "-" || (b.s[0] === "." && a.s.includes(".")));
  };
  const render = (letter, toks) => {
    let s = "", p = prevTok;
    if (!(state !== null && letter === state)) { s += letter; p = null; }
    for (const t of toks) { if (sepNeeded(p, t)) s += " "; s += t.s; p = t; }
    return { s, last: toks.length ? toks[toks.length - 1] : null };
  };

  for (const seg of abs) {
    let cands;
    if (seg.k === "M") {
      cands = [["m", [N(seg.x - cx), N(seg.y - cy)]], ["M", [N(seg.x), N(seg.y)]]];
    } else if (seg.k === "L") {
      const dx = seg.x - cx, dy = seg.y - cy;
      cands = [];
      if (dy === 0) cands.push(["h", [N(dx)]], ["H", [N(seg.x)]]);
      if (dx === 0 && dy !== 0) cands.push(["v", [N(dy)]], ["V", [N(seg.y)]]);
      cands.push(["l", [N(dx), N(dy)]], ["L", [N(seg.x), N(seg.y)]]);
    } else if (seg.k === "C") {
      const refX = prevSeg && prevSeg.k === "C" ? 2 * cx - prevSeg.x2 : cx;
      const refY = prevSeg && prevSeg.k === "C" ? 2 * cy - prevSeg.y2 : cy;
      cands = [];
      if (seg.x1 === refX && seg.y1 === refY) {
        cands.push(["s", [N(seg.x2 - cx), N(seg.y2 - cy), N(seg.x - cx), N(seg.y - cy)]],
                   ["S", [N(seg.x2), N(seg.y2), N(seg.x), N(seg.y)]]);
      }
      cands.push(["c", [N(seg.x1 - cx), N(seg.y1 - cy), N(seg.x2 - cx), N(seg.y2 - cy), N(seg.x - cx), N(seg.y - cy)]],
                 ["C", [N(seg.x1), N(seg.y1), N(seg.x2), N(seg.y2), N(seg.x), N(seg.y)]]);
    } else if (seg.k === "Q") {
      const refX = prevSeg && prevSeg.k === "Q" ? 2 * cx - prevSeg.x1 : cx;
      const refY = prevSeg && prevSeg.k === "Q" ? 2 * cy - prevSeg.y1 : cy;
      cands = [];
      if (seg.x1 === refX && seg.y1 === refY) cands.push(["t", [N(seg.x - cx), N(seg.y - cy)]], ["T", [N(seg.x), N(seg.y)]]);
      cands.push(["q", [N(seg.x1 - cx), N(seg.y1 - cy), N(seg.x - cx), N(seg.y - cy)]],
                 ["Q", [N(seg.x1), N(seg.y1), N(seg.x), N(seg.y)]]);
    } else if (seg.k === "A") {
      const head = [N(seg.rx), N(seg.ry), R(seg.rot), FL(seg.f1), FL(seg.f2)];
      cands = [["a", [...head, N(seg.x - cx), N(seg.y - cy)]], ["A", [...head, N(seg.x), N(seg.y)]]];
    } else {
      cands = [["z", []]];
    }
    let best = null;
    for (const [letter, toks] of cands) {
      const r = render(letter, toks);
      if (!best || r.s.length < best.r.s.length) best = { letter, r };
    }
    out += best.r.s;
    if (best.r.last !== null) prevTok = best.r.last;
    if (seg.k === "Z") { state = null; prevTok = null; cx = sx; cy = sy; }
    else {
      state = best.letter === "m" ? "l" : best.letter === "M" ? "L" : best.letter;
      if (seg.k === "M") { sx = seg.x; sy = seg.y; }
      cx = seg.x; cy = seg.y;
    }
    prevSeg = seg;
  }
  return out;
}

/* ---------- transforms over the tree ---------- */

function optimizeAttrValues(node, opts) {
  for (const a of node.attrs) {
    if (a.value == null) continue;
    if (a.name === "d") { a.value = optimizePath(a.value, opts.precision); continue; }
    if (opts.shortenColors && COLOR_ATTRS.has(a.name)) { a.value = shortenColor(a.value); continue; }
    if (TRANSFORM_ATTRS.has(a.name)) { a.value = simplifyTransform(roundNumberList(a.value, opts.transformPrecision).replace(/,\s+/g, ",")); continue; }
    // Lists like viewBox and points round their numbers but KEEP their
    // separators: the compact "-"-glued spelling is only grammatical inside
    // path data, and Gecko rejects it in attribute number lists.
    if (NUMLIST_ATTRS.has(a.name)) { a.value = roundNumberList(a.value, opts.precision); continue; }
    if (NUM_ATTRS.has(a.name)) {
      a.value = DIMENSION_ATTRS.has(a.name)
        ? a.value.replace(NUM_TOKEN, (m) => fmtNumDimension(parseFloat(m), opts.precision))
        : roundNumberList(a.value, opts.precision);
      continue;
    }
    if (a.name === "style") { a.value = cleanStyle(a.value, opts); }
  }
}

function shortenStyleColors(style) {
  return style.replace(/(fill|stroke|stop-color|color|flood-color|lighting-color)\s*:\s*([^;]+)/gi,
    (_, prop, val) => `${prop}:${shortenColor(val)}`);
}

function cleanStyle(style, opts) {
  let s = style.replace(/(^|;)\s*enable-background\s*:[^;]*/gi, "$1");
  if (opts.shortenColors) s = shortenStyleColors(s);
  return s.replace(/;\s*;/g, ";").replace(/^\s*;\s*/, "").replace(/\s*;\s*$/, "").trim();
}

// Walk that stays inside SVG territory: it does not descend into a
// foreignObject, whose children are HTML with their own CSS world. Touching
// their class or style there rewires a document this engine does not model.
function walkSvg(node, fn) {
  fn(node);
  if (!node.children) return;
  if (node.type === "element" && localName(node.name) === "foreignobject") return;
  for (const c of node.children) walkSvg(c, fn);
}

// Every live stylesheet element, under any prefix or case (<style>, <svg:style>).
function styleSheetEls(root) {
  const els = [];
  walk(root, (n) => { if (n.type === "element" && localName(n.name) === "style" && !n._remove) els.push(n); });
  return els;
}

// Fold a trivial Illustrator/editor stylesheet into presentation attributes.
// Only the simplest case is handled: a single screen-media <style> of flat
// single-class rules, where EVERY classed element uses exactly one class that
// the sheet defines. If any element cannot be fully inlined, or a value
// carries !important, the whole stylesheet is left intact, because inlining a
// subset and then deleting the sheet would strip the styling off the rest.
function inlineTrivialStyles(root) {
  const styleEls = styleSheetEls(root);
  if (styleEls.length !== 1) return false;
  const styleNode = styleEls[0];
  // A media-scoped or non-CSS sheet cannot be flattened into attributes that
  // apply everywhere.
  const media = styleNode.attrs.find((a) => a.name === "media")?.value;
  if (media != null && media.trim() !== "" && media.trim().toLowerCase() !== "all") return false;
  const type = styleNode.attrs.find((a) => a.name === "type")?.value;
  if (type != null && type.trim() !== "" && type.trim().toLowerCase() !== "text/css") return false;
  let css = (styleNode.children || []).map((c) => (c.type === "text" || c.type === "cdata") ? c.value : "").join("");
  css = css.replace(/\/\*[\s\S]*?\*\//g, " "); // comments are not declarations
  if (/!important/i.test(css)) return false; // an !important value cannot be safely moved to a presentation attribute

  // One forward pass over "selector { declarations }" chunks: linear, and the
  // selector is inspected directly instead of re-scanning a growing prefix.
  const rules = new Map();
  let pos = 0;
  while (true) {
    const open = css.indexOf("{", pos);
    if (open === -1) {
      if (/[^\s]/.test(css.slice(pos))) return false; // trailing junk that is not a rule
      break;
    }
    const close = css.indexOf("}", open + 1);
    if (close === -1) return false; // unbalanced sheet
    const sel = css.slice(pos, open).trim();
    if (!/^\.[-_a-zA-Z0-9]+$/.test(sel)) return false; // only one plain class per rule
    const cls = sel.slice(1);
    if (rules.has(cls)) return false; // duplicated selector, priority matters
    rules.set(cls, css.slice(open + 1, close).trim().replace(/;\s*$/, ""));
    pos = close + 1;
  }
  if (rules.size === 0) return false;

  // Every classed element must be fully inlinable, or the sheet stays. The
  // scan does not enter foreignObject: HTML classes are none of our business.
  const classed = [];
  let allInlinable = true;
  walkSvg(root, (node) => {
    if (node.type !== "element") return;
    const classAttr = node.attrs.find((a) => a.name === "class");
    if (!classAttr || classAttr.value == null) return;
    const classes = classAttr.value.trim().split(/\s+/).filter(Boolean);
    classed.push({ node, classAttr, classes });
    if (classes.length !== 1 || !rules.has(classes[0])) allInlinable = false;
  });
  if (classed.length === 0 || !allInlinable) return false;
  // A class living inside foreignObject means the sheet styles HTML too; the
  // single-sheet model above no longer holds, so everything stays put.
  let classInForeign = false;
  walk(root, (node) => {
    if (node.type === "element" && localName(node.name) === "foreignobject") {
      walk(node, (inner) => {
        if (inner !== node && inner.type === "element" && inner.attrs.some((a) => a.name === "class")) classInForeign = true;
      });
    }
  });
  if (classInForeign) return false;

  for (const { node, classAttr, classes } of classed) {
    const styleAttr = node.attrs.find((a) => a.name === "style");
    const inlineProps = styleAttr && styleAttr.value
      ? new Set([...styleAttr.value.matchAll(/([-a-zA-Z]+)\s*:/g)].map((mm) => mm[1].toLowerCase()))
      : new Set();
    for (const decl of rules.get(classes[0]).split(";")) {
      const idx = decl.indexOf(":");
      if (idx === -1) continue;
      // CSS property names are case-insensitive; the attribute they become is
      // not. Lowercase, or an uppercase declaration turns into a dead attribute.
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const val = decl.slice(idx + 1).trim();
      if (!prop) continue;
      if (inlineProps.has(prop)) continue; // an inline style outranks the class, keep it
      const existing = node.attrs.find((a) => a.name === prop);
      if (existing) existing.value = val;                // the class outranks a presentation attribute
      else node.attrs.push({ name: prop, value: val, quote: '"' });
    }
    node.attrs = node.attrs.filter((a) => a !== classAttr);
  }
  styleNode._remove = true;
  return true;
}

// Move whitelisted style-attribute declarations onto presentation attributes.
// Only runs when the document keeps no stylesheet: with no competing CSS, the
// inline declaration and the attribute compute to the same value, and the
// attribute form is shorter and unlocks the default-value and color passes.
// A declaration that is not whitelisted, carries !important, or hides inside
// an unparseable value stays exactly where it was.
// True when a url(...) token in the value carries a separator character that
// would defeat the naive split below. A linear scan, immune to the quadratic
// backtracking a hostile crafted style attribute could feed a regex.
function urlHidesSeparator(value) {
  let from = 0;
  while (true) {
    const u = value.indexOf("url(", from);
    if (u === -1) return false;
    const close = value.indexOf(")", u + 4);
    if (close === -1) return true; // unclosed url(), do not risk the split
    const inner = value.slice(u + 4, close);
    if (inner.includes(";") || inner.includes("{") || inner.includes("}")) return true;
    from = close + 1;
  }
}

function convertStylesToAttrs(root) {
  if (styleSheetEls(root).length > 0) return;
  walkSvg(root, (n) => {
    if (n.type !== "element") return;
    const sa = n.attrs.find((a) => a.name === "style");
    if (!sa || sa.value == null) return;
    if (urlHidesSeparator(sa.value)) return;
    const decls = [];
    for (const raw of sa.value.split(";")) {
      const idx = raw.indexOf(":");
      if (idx === -1) { decls.push({ raw: raw.trim() }); continue; }
      decls.push({ raw: raw.trim(), prop: raw.slice(0, idx).trim().toLowerCase(), val: raw.slice(idx + 1).trim() });
    }
    // A property declared twice relies on CSS's parse-time fallback, where the
    // last VALID value wins. This engine does not validate values, so those
    // declarations stay inline exactly as written.
    const counts = new Map();
    for (const d of decls) if (d.prop) counts.set(d.prop, (counts.get(d.prop) || 0) + 1);
    const keep = [];
    for (const d of decls) {
      if (!d.prop || !STYLE_TO_ATTR.has(d.prop) || d.val === "" || /!important/i.test(d.val) || counts.get(d.prop) > 1) {
        if (d.raw) keep.push(d.raw);
        continue;
      }
      const existing = n.attrs.find((a) => a.name === d.prop);
      if (existing) existing.value = d.val; // the style declaration outranked the attribute, so its value wins
      else n.attrs.push({ name: d.prop, value: d.val, quote: '"' });
    }
    if (keep.length) sa.value = keep.join(";");
    else n.attrs = n.attrs.filter((a) => a !== sa);
  });
}

function prefixOf(name) {
  const idx = name.indexOf(":");
  return idx === -1 ? "" : name.slice(0, idx);
}
function localName(name) {
  const lower = name.toLowerCase();
  const idx = lower.indexOf(":");
  return idx === -1 ? lower : lower.slice(idx + 1);
}

// Whether a url points at code, even when disguised with entities or embedded
// whitespace/control characters (a browser strips those before dispatching).
function isDangerousUrl(value) {
  if (!value) return false;
  const decoded = value
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; } });
  const bare = decoded.replace(/[\s -]/g, "").toLowerCase();
  return bare.startsWith("javascript:") || bare.startsWith("vbscript:");
}

function transformOnce(root, refs, opts, report) {
  let changed = false;

  // A surviving stylesheet can address elements structurally (defs > *), so
  // structure-changing passes below stand down while one exists.
  const hasSheet = styleSheetEls(root).length > 0;

  function processChildren(parent, ancestorNonDefault) {
    const kept = [];
    for (const node of parent.children) {
      if (node.type === "comment") {
        if (opts.removeComments) { changed = true; continue; }
        kept.push(node); continue;
      }
      if (node.type === "decl" || node.type === "pi") { changed = true; continue; }
      if (node.type === "doctype") { changed = true; report.doctype = true; continue; }
      if (node.type === "cdata" || node.type === "text") { kept.push(node); continue; }
      if (node.type !== "element") { kept.push(node); continue; }

      const name = node.name;
      const local = localName(name);
      const prefix = prefixOf(name);

      // editor-only elements, namespaces, and code (matched case-insensitively,
      // so an uppercase <SCRIPT> or namespaced <svg:script> is caught too)
      if (opts.removeMetadata && (local === "metadata" || name.toLowerCase() === "sodipodi:namedview")) { changed = true; continue; }
      if (opts.removeEditorData && EDITOR_PREFIXES.includes(prefix.toLowerCase())) { changed = true; continue; }
      if (opts.removeScripts && local === "script") { changed = true; report.script = true; continue; }
      if (opts.removeTitleDesc && (local === "title" || local === "desc")) { changed = true; continue; }
      if (node._remove) { changed = true; continue; } // stylesheet folded away

      // xlink:href is the SVG 1.1 spelling; every current renderer takes plain
      // href, which is shorter and frees the xmlns:xlink declaration to go too.
      if (!node.attrs.some((a) => a.name === "href")) {
        const xl = node.attrs.find((a) => a.name === "xlink:href");
        if (xl) { xl.name = "href"; changed = true; }
      }

      // Normalize values first, so default-value removal compares against the
      // canonical form and the whole optimize() stays idempotent.
      optimizeAttrValues(node, opts);
      // A style or transform that emptied out (or an identity transform that
      // simplified to nothing) carries no rendering information at all.
      node.attrs = node.attrs.filter((a) =>
        !((a.name === "style" || TRANSFORM_ATTRS.has(a.name)) && (a.value == null || a.value.trim() === "")));

      // What this element passes down for inherited properties: it adds a
      // property it sets to a non-default value, and clears one it resets to
      // the default. Computed before removal so a to-be-removed default resets
      // correctly.
      const childNonDefault = new Set(ancestorNonDefault);
      for (const a of node.attrs) {
        if (!INHERITED_DEFAULTS.has(a.name)) continue;
        if (a.value === DEFAULT_ATTRS[a.name]) childNonDefault.delete(a.name);
        else childNonDefault.add(a.name);
      }
      // A surviving style attribute (kept inline for !important or an
      // unconvertible value) also sets inherited properties, and it outranks
      // the attributes modeled above. Anything it declares counts as
      // non-default, conservatively, so a descendant's explicit default that
      // overrides it is never removed.
      const styleAttrVal = node.attrs.find((a) => a.name === "style")?.value;
      if (styleAttrVal) {
        for (const decl of styleAttrVal.split(";")) {
          const idx = decl.indexOf(":");
          if (idx === -1) continue;
          const prop = decl.slice(0, idx).trim().toLowerCase();
          if (INHERITED_DEFAULTS.has(prop)) childNonDefault.add(prop);
        }
      }

      // attribute cleanup
      const attrsBefore = node.attrs.length;
      node.attrs = node.attrs.filter((a) => {
        const p = prefixOf(a.name).toLowerCase();
        if (opts.removeEditorData) {
          if (EDITOR_PREFIXES.includes(p)) return false;
          if (a.name.startsWith("xmlns:") && EDITOR_PREFIXES.includes(a.name.slice(6).toLowerCase())) return false;
          if (a.name === "data-name") return false;
        }
        if (opts.removeScripts) {
          if (/^on/i.test(a.name)) { report.handler = true; return false; }
          if ((a.name === "href" || a.name === "xlink:href") && isDangerousUrl(a.value)) { report.jsurl = true; return false; }
        }
        if (a.name in DEFAULT_ATTRS && a.value === DEFAULT_ATTRS[a.name]) {
          // An inherited default may only go when no ancestor overrode it.
          if (INHERITED_DEFAULTS.has(a.name) && ancestorNonDefault.has(a.name)) return true;
          return false;
        }
        if (local === "svg" && (a.name === "version" || a.name === "baseProfile" || a.name === "enable-background" || a.name === "x" || a.name === "y")) {
          if (a.name === "x" || a.name === "y") { if (a.value === "0" || a.value === "0px") return false; return true; }
          return false;
        }
        return true;
      });
      if (node.attrs.length !== attrsBefore) changed = true;

      // remove unreferenced ids
      if (opts.removeUnreferencedIds) {
        const before = node.attrs.length;
        node.attrs = node.attrs.filter((a) => !(a.name === "id" && !refs.has(a.value)));
        if (node.attrs.length !== before) changed = true;
      }

      // recurse before deciding whether this element is now empty
      if (node.children && !isTextContent(name)) processChildren(node, childNonDefault);

      // collapse empty defs/g and unwrap pointless single-child groups
      if (opts.collapseGroups) {
        const meaningful = node.children.filter((c) =>
          !(c.type === "text" && c.value.trim() === "") && c.type !== "comment");
        if ((local === "g" || local === "defs") && meaningful.length === 0) { changed = true; continue; }
        if (local === "g" && node.attrs.length === 0) {
          for (const c of node.children) kept.push(c);
          changed = true;
          continue;
        }
        // A bare <defs> holding only definition elements (gradients, patterns,
        // markers…) is a wrapper with no effect: those render only by
        // reference wherever they sit. Left alone while a stylesheet exists.
        if (local === "defs" && node.attrs.length === 0 && !hasSheet &&
            meaningful.every((c) => c.type === "element" && NEVER_RENDERED.has(localName(c.name)))) {
          for (const c of node.children) kept.push(c);
          changed = true;
          continue;
        }
      }
      kept.push(node);
    }
    parent.children = kept;
  }

  processChildren(root, new Set());
  return changed;
}

/* ---------- serialize ---------- */

// Escape a bare '&', but leave an existing entity reference (named or numeric)
// alone, so text and attributes round-trip and the optimizer stays idempotent.
const BARE_AMP = /&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g;
function escapeAttr(v) {
  return v.replace(BARE_AMP, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
function escapeText(v) {
  return v.replace(BARE_AMP, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serialize(root, opts) {
  const nl = opts.prettify ? "\n" : "";
  const pad = opts.prettify ? (d) => "  ".repeat(d) : () => "";
  let out = "";

  function attrs(node) {
    let s = "";
    for (const a of node.attrs) {
      s += a.value == null ? " " + a.name : ` ${a.name}="${escapeAttr(a.value)}"`;
    }
    return s;
  }

  function emitInline(node) {
    if (node.type === "text") return escapeText(node.value);
    if (node.type === "cdata") return `<![CDATA[${node.value}]]>`;
    if (node.type === "comment") return `<!--${node.value}-->`;
    if (node.type !== "element") return node.raw || "";
    const open = `<${node.name}${attrs(node)}`;
    if (!node.children || node.children.length === 0) return open + "/>";
    let inner = "";
    for (const c of node.children) inner += emitInline(c);
    return `${open}>${inner}</${node.name}>`;
  }

  function emit(node, depth) {
    if (node.type === "text") {
      if (node.value.trim() === "") return; // insignificant whitespace between elements
      out += pad(depth) + escapeText(node.value.trim()) + nl;
      return;
    }
    if (node.type === "comment") { out += pad(depth) + `<!--${node.value}-->` + nl; return; }
    if (node.type === "cdata") { out += pad(depth) + `<![CDATA[${node.value}]]>` + nl; return; }
    if (node.type === "doctype" || node.type === "decl" || node.type === "pi") { out += pad(depth) + node.raw + nl; return; }
    if (node.type !== "element") return;

    const open = `<${node.name}${attrs(node)}`;
    const kids = node.children || [];

    // Text-content elements are emitted verbatim, before the empty check, so a
    // <text> holding only whitespace keeps that whitespace rather than becoming
    // a self-closing tag.
    if (isTextContent(node.name)) {
      if (kids.length === 0) { out += pad(depth) + open + "/>" + nl; return; }
      let inner = "";
      for (const c of kids) inner += emitInline(c);
      out += pad(depth) + open + ">" + inner + `</${node.name}>` + nl;
      return;
    }

    const meaningful = kids.filter((c) => !(c.type === "text" && c.value.trim() === ""));
    if (meaningful.length === 0) { out += pad(depth) + open + "/>" + nl; return; }
    out += pad(depth) + open + ">" + nl;
    for (const c of kids) emit(c, depth + 1);
    out += pad(depth) + `</${node.name}>` + nl;
  }

  for (const node of root.children) emit(node, 0);
  return opts.prettify ? out.replace(/\n+$/, "\n") : out;
}

/* ---------- public API ---------- */

// On a small or normalized viewBox, two decimal places is coarse enough to
// move a curve. Raise the coordinate precision floor so the smallest step stays
// under about half a percent of the drawing; never lower what the user asked.
function precisionForViewBox(root, base) {
  const svgEl = root.children.find((c) => c.type === "element" && c.name.toLowerCase() === "svg");
  if (!svgEl) return base;
  let dim = 0;
  const vb = svgEl.attrs.find((a) => a.name === "viewBox");
  if (vb) {
    const p = (vb.value.match(NUM_TOKEN) || []).map(Number);
    if (p.length === 4 && isFinite(p[2]) && isFinite(p[3])) dim = Math.max(Math.abs(p[2]), Math.abs(p[3]));
  }
  if (!dim) {
    const w = parseFloat(svgEl.attrs.find((a) => a.name === "width")?.value);
    const h = parseFloat(svgEl.attrs.find((a) => a.name === "height")?.value);
    dim = Math.max(isFinite(w) ? w : 0, isFinite(h) ? h : 0);
  }
  if (dim <= 0) return base;
  // The passes round the viewBox itself, so the choice must be a fixed point:
  // compute it from the dimension AS IT WILL BE WRITTEN, or a value that
  // crosses a power of ten under rounding would give the second run a
  // different precision than the first.
  dim = Math.abs(Number(dim.toFixed(base)));
  if (dim <= 0) return Math.min(6, Math.max(base, 6));
  return Math.min(6, Math.max(base, Math.ceil(Math.log10(200 / dim))));
}

export function optimize(source, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const before = byteLength(source);
  const { root, errors } = parse(source.trim());

  const hasSvg = root.children.some((c) => c.type === "element" && c.name.toLowerCase() === "svg");
  if (!hasSvg) {
    return { ok: false, error: "No <svg> element found. Paste the full SVG markup, including the opening <svg> tag.", svg: source, before, after: before, saved: 0, savedPercent: 0, notes: [], errors };
  }

  const report = {};
  // Coordinate precision beyond six places buys nothing visible and pushes the
  // path encoder's exact-integer space toward overflow; clamp both knobs.
  const clamp = (v, lo, hi, fb) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fb;
  const basePrecision = clamp(opts.precision, 0, 6, DEFAULTS.precision);
  const runOpts = { ...opts, transformPrecision: clamp(opts.transformPrecision, 0, 8, DEFAULTS.transformPrecision) };
  if (opts.inlineStyles) inlineTrivialStyles(root);

  runOpts.precision = precisionForViewBox(root, basePrecision);
  let rounds = 0;
  const maxRounds = opts.multipass ? 4 : 1;
  do {
    rounds++;
    // Both run inside the loop: an earlier round can remove the last
    // stylesheet (an editor-namespaced one, say), which is exactly the state
    // the conversion needs, and removals can orphan references, which the
    // next round's id pass should see fresh.
    if (opts.inlineStyles) convertStylesToAttrs(root);
  } while (transformOnce(root, collectReferences(root), runOpts, report) && rounds < maxRounds);

  // xmlns:xlink is dead weight once nothing uses the xlink: prefix.
  let usesXlink = false;
  walk(root, (n) => { if (n.type === "element") for (const a of n.attrs) if (a.name.startsWith("xlink:")) usesXlink = true; });
  if (!usesXlink) walk(root, (n) => { if (n.type === "element") n.attrs = n.attrs.filter((a) => a.name !== "xmlns:xlink"); });

  // xml:space only governs whitespace inside rendered <text>; with none in the
  // document it is noise Illustrator leaves on the root.
  if (opts.removeEditorData) {
    let hasText = false;
    walk(root, (n) => { if (n.type === "element" && ["text", "tspan", "textpath"].includes(n.name.toLowerCase())) hasText = true; });
    if (!hasText) walk(root, (n) => { if (n.type === "element") n.attrs = n.attrs.filter((a) => a.name !== "xml:space"); });
  }

  const svg = serialize(root, opts).trim() + (opts.prettify ? "\n" : "");
  const after = byteLength(svg);

  const notes = [];
  if (report.script) notes.push({ kind: "security", text: "Removed a <script> element. This file carried code, which a static graphic does not need." });
  if (report.handler) notes.push({ kind: "security", text: "Removed inline event handlers (on… attributes). They ran code on interaction." });
  if (report.jsurl) notes.push({ kind: "security", text: "Removed a javascript: link." });
  if (report.doctype) notes.push({ kind: "info", text: "Dropped the DOCTYPE. Modern SVG does not use one." });

  return {
    ok: true,
    svg,
    before,
    after,
    saved: before - after,
    savedPercent: before === 0 ? 0 : Math.round(((before - after) / before) * 1000) / 10,
    notes,
    errors,
  };
}

export function byteLength(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str).length;
  return Buffer.byteLength(str, "utf8");
}

/* ---------- color editing ----------
   These power the in-browser recolor panel. listPaints enumerates the editable
   paints; applyRecolor writes a chosen-color map back into the SVG. The key for
   a solid color is the color string itself (so every part painted that color
   moves together); the key for a gradient stop is `grad:<id>:<stopIndex>`. */

const NOT_A_COLOR = /^(url\(|none$|inherit$|currentcolor$|transparent$|context-)/i;
const styleProp = (style, prop) => {
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i").exec(style || "");
  return m ? m[1].trim() : null;
};
const setStyleProp = (style, prop, val) => {
  const re = new RegExp("((?:^|;)\\s*" + prop + "\\s*:\\s*)([^;]+)", "i");
  return re.test(style) ? style.replace(re, "$1" + val) : style;
};
const gradientStops = (node) => (node.children || []).filter((c) => c.type === "element" && c.name.toLowerCase() === "stop");
const stopColor = (stop) => {
  const attr = stop.attrs.find((a) => a.name === "stop-color");
  if (attr && attr.value != null) return attr.value.trim();
  return styleProp(stop.attrs.find((a) => a.name === "style")?.value, "stop-color");
};

export function listPaints(svg) {
  const { root } = parse(svg);
  const colorCounts = new Map();
  const gradients = [];
  const add = (v) => { if (v != null && !NOT_A_COLOR.test(v.trim())) { const k = v.trim(); colorCounts.set(k, (colorCounts.get(k) || 0) + 1); } };
  walk(root, (node) => {
    if (node.type !== "element") return;
    const lname = node.name.toLowerCase();
    if (lname === "lineargradient" || lname === "radialgradient") {
      const id = node.attrs.find((a) => a.name === "id")?.value;
      if (!id) return;
      const stops = gradientStops(node).map((s, index) => ({ index, offset: (s.attrs.find((a) => a.name === "offset")?.value ?? "0"), color: stopColor(s) }))
        .filter((s) => s.color);
      if (stops.length) gradients.push({ id, type: lname === "radialgradient" ? "radial" : "linear", stops });
      return;
    }
    if (lname === "stop") return; // counted with its gradient
    // An inline style outranks a presentation attribute, so when both set a
    // channel, the style value is the one that paints and the attribute is
    // shadowed. List only the effective one.
    const style = node.attrs.find((a) => a.name === "style")?.value;
    const styleFill = styleProp(style, "fill"), styleStroke = styleProp(style, "stroke");
    for (const a of node.attrs) {
      if (a.name === "fill" && styleFill == null) add(a.value);
      if (a.name === "stroke" && styleStroke == null) add(a.value);
    }
    if (styleFill != null) add(styleFill);
    if (styleStroke != null) add(styleStroke);
  });
  return {
    colors: [...colorCounts.entries()].map(([value, uses]) => ({ value, uses })),
    gradients,
  };
}

export function applyRecolor(svg, recolor, opts = {}) {
  if (!recolor || Object.keys(recolor).length === 0) return svg;
  const merged = { ...DEFAULTS, ...opts };
  const { root } = parse(svg);
  walk(root, (node) => {
    if (node.type !== "element") return;
    const lname = node.name.toLowerCase();
    if (lname === "lineargradient" || lname === "radialgradient") {
      const id = node.attrs.find((a) => a.name === "id")?.value;
      if (!id) return;
      gradientStops(node).forEach((stop, index) => {
        const next = recolor[`grad:${id}:${index}`];
        if (next == null) return;
        const attr = stop.attrs.find((a) => a.name === "stop-color");
        if (attr) { attr.value = next; return; }
        const style = stop.attrs.find((a) => a.name === "style");
        if (style && /stop-color/i.test(style.value)) style.value = setStyleProp(style.value, "stop-color", next);
        else stop.attrs.push({ name: "stop-color", value: next, quote: '"' });
      });
      return;
    }
    if (lname === "stop") return;
    for (const a of node.attrs) {
      if ((a.name === "fill" || a.name === "stroke") && a.value != null && recolor[a.value.trim()] != null) {
        a.value = recolor[a.value.trim()];
      }
      if (a.name === "style") {
        for (const prop of ["fill", "stroke"]) {
          const cur = styleProp(a.value, prop);
          if (cur != null && recolor[cur] != null) a.value = setStyleProp(a.value, prop, recolor[cur]);
        }
      }
    }
  });
  return serialize(root, merged).trim() + (merged.prettify ? "\n" : "");
}
