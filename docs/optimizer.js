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
        if (!parsed.selfClose) stack.push(el);
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

function parseTag(input, start) {
  let i = start + 1;
  const n = input.length;
  const nameMatch = /^[^\s/>]+/.exec(input.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i += name.length;
  const attrs = [];
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (input[i] === ">") return { name, attrs, selfClose: false, end: i + 1 };
    if (input[i] === "/" && input[i + 1] === ">") return { name, attrs, selfClose: true, end: i + 2 };
    const am = /^[^\s=/>]+/.exec(input.slice(i));
    if (!am) { i++; continue; }
    const aname = am[0];
    i += aname.length;
    while (i < n && /\s/.test(input[i])) i++;
    if (input[i] === "=") {
      i++;
      while (i < n && /\s/.test(input[i])) i++;
      const q = input[i];
      if (q === '"' || q === "'") {
        const end = input.indexOf(q, i + 1);
        const stop = end === -1 ? n : end;
        attrs.push({ name: aname, value: decodeEntities(input.slice(i + 1, stop)), quote: '"' });
        i = end === -1 ? n : end + 1;
      } else {
        const vm = /^[^\s/>]+/.exec(input.slice(i));
        const value = vm ? vm[0] : "";
        attrs.push({ name: aname, value, quote: '"' });
        i += value.length;
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

function optimizePath(d, precision) {
  const segs = [];
  let i = 0;
  const n = d.length;
  const ws = (ch) => ch === " " || ch === "," || ch === "\t" || ch === "\n" || ch === "\r";
  const readNumber = () => {
    while (i < n && ws(d[i])) i++;
    const start = i;
    if (d[i] === "+" || d[i] === "-") i++;
    while (i < n && d[i] >= "0" && d[i] <= "9") i++;
    if (d[i] === ".") { i++; while (i < n && d[i] >= "0" && d[i] <= "9") i++; }
    if (d[i] === "e" || d[i] === "E") { i++; if (d[i] === "+" || d[i] === "-") i++; while (i < n && d[i] >= "0" && d[i] <= "9") i++; }
    return start === i ? null : d.slice(start, i);
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
    if (/[a-zA-Z]/.test(ch)) { cmd = ch; i++; }
    else if (cmd == null) { i++; continue; }
    const lower = (cmd || "").toLowerCase();
    if (lower === "z") { segs.push({ cmd, args: [] }); continue; }
    const count = PATH_ARGS[lower];
    if (count == null) { i++; continue; }
    const args = [];
    let ok = true;
    for (let k = 0; k < count; k++) {
      if (lower === "a" && (k === 3 || k === 4)) {
        const f = readFlag();
        if (f == null) { ok = false; break; }
        args.push({ flag: true, v: f });
      } else {
        const num = readNumber();
        if (num == null) { ok = false; break; }
        args.push({ flag: false, v: fmtNum(parseFloat(num), precision) });
      }
    }
    if (!ok) break;
    segs.push({ cmd, args });
    if (lower === "m") cmd = cmd === "M" ? "L" : "l";
  }

  let out = "";
  let prevCmd = "";
  for (const seg of segs) {
    if (seg.cmd !== prevCmd) { out += seg.cmd; prevCmd = seg.cmd; }
    else if (seg.args.length) {
      const first = seg.args[0].v;
      if (!(first[0] === "-" || first[0] === ".")) out += " ";
    }
    for (let k = 0; k < seg.args.length; k++) {
      const v = seg.args[k].v;
      if (k > 0) {
        const prev = seg.args[k - 1].v;
        const needsSep = !(v[0] === "-" || (v[0] === "." && prev.includes(".")));
        if (needsSep) out += " ";
      }
      out += v;
    }
  }
  return out;
}

/* ---------- transforms over the tree ---------- */

function optimizeAttrValues(node, opts) {
  for (const a of node.attrs) {
    if (a.value == null) continue;
    if (a.name === "d") { a.value = optimizePath(a.value, opts.precision); continue; }
    if (opts.shortenColors && COLOR_ATTRS.has(a.name)) { a.value = shortenColor(a.value); continue; }
    if (TRANSFORM_ATTRS.has(a.name)) { a.value = roundNumberList(a.value, opts.transformPrecision).replace(/,\s+/g, ","); continue; }
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

// Fold a trivial Illustrator/editor stylesheet into presentation attributes.
// Only the simplest case is handled: a single <style> of flat single-class
// rules, where EVERY classed element uses exactly one class that the sheet
// defines. If any element cannot be fully inlined, or a value carries
// !important, the whole stylesheet is left intact, because inlining a subset
// and then deleting the sheet would strip the styling off the rest.
function inlineTrivialStyles(root) {
  const styleEls = [];
  walk(root, (node) => { if (node.type === "element" && node.name.toLowerCase() === "style") styleEls.push(node); });
  if (styleEls.length !== 1) return false;
  const styleNode = styleEls[0];
  const css = (styleNode.children || []).map((c) => (c.type === "text" || c.type === "cdata") ? c.value : "").join("");
  if (/!important/i.test(css)) return false; // an !important value cannot be safely moved to a presentation attribute
  const selectorText = css.replace(/\{[^}]*\}/g, " "); // strip declaration blocks, leaving only the selectors
  if (/[@>+~[]/.test(selectorText) || /:/.test(selectorText)) return false; // at-rules, combinators, attribute or pseudo selectors
  const rules = new Map();
  const ruleRe = /\.([-_a-zA-Z0-9]+)\s*\{([^}]*)\}/g;
  let m, matched = 0, total = (css.match(/\{/g) || []).length;
  while ((m = ruleRe.exec(css))) {
    if (css.slice(0, m.index).replace(/\s/g, "").endsWith(",")) return false; // grouped selector, bail
    if (rules.has(m[1])) return false; // duplicated selector, priority matters
    rules.set(m[1], m[2].trim().replace(/;\s*$/, ""));
    matched++;
  }
  if (matched === 0 || matched !== total) return false;

  // Every classed element must be fully inlinable, or the sheet stays.
  const classed = [];
  let allInlinable = true;
  walk(root, (node) => {
    if (node.type !== "element") return;
    const classAttr = node.attrs.find((a) => a.name === "class");
    if (!classAttr || classAttr.value == null) return;
    const classes = classAttr.value.trim().split(/\s+/).filter(Boolean);
    classed.push({ node, classAttr, classes });
    if (classes.length !== 1 || !rules.has(classes[0])) allInlinable = false;
  });
  if (classed.length === 0 || !allInlinable) return false;

  for (const { node, classAttr, classes } of classed) {
    const styleAttr = node.attrs.find((a) => a.name === "style");
    const inlineProps = styleAttr && styleAttr.value
      ? new Set([...styleAttr.value.matchAll(/([-a-zA-Z]+)\s*:/g)].map((mm) => mm[1].toLowerCase()))
      : new Set();
    for (const decl of rules.get(classes[0]).split(";")) {
      const idx = decl.indexOf(":");
      if (idx === -1) continue;
      const prop = decl.slice(0, idx).trim();
      const val = decl.slice(idx + 1).trim();
      if (!prop) continue;
      if (inlineProps.has(prop.toLowerCase())) continue; // an inline style outranks the class, keep it
      const existing = node.attrs.find((a) => a.name === prop);
      if (existing) existing.value = val;                // the class outranks a presentation attribute
      else node.attrs.push({ name: prop, value: val, quote: '"' });
    }
    node.attrs = node.attrs.filter((a) => a !== classAttr);
  }
  styleNode._remove = true;
  return true;
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

      // Normalize values first, so default-value removal compares against the
      // canonical form and the whole optimize() stays idempotent.
      optimizeAttrValues(node, opts);
      node.attrs = node.attrs.filter((a) => !(a.name === "style" && (a.value == null || a.value.trim() === "")));

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
    const p = vb.value.split(/[\s,]+/).map(Number);
    if (p.length === 4 && isFinite(p[2]) && isFinite(p[3])) dim = Math.max(Math.abs(p[2]), Math.abs(p[3]));
  }
  if (!dim) {
    const w = parseFloat(svgEl.attrs.find((a) => a.name === "width")?.value);
    const h = parseFloat(svgEl.attrs.find((a) => a.name === "height")?.value);
    dim = Math.max(isFinite(w) ? w : 0, isFinite(h) ? h : 0);
  }
  if (dim <= 0) return base;
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
  if (opts.inlineStyles) inlineTrivialStyles(root);
  const refs = collectReferences(root);

  const runOpts = { ...opts, precision: precisionForViewBox(root, opts.precision) };
  let rounds = 0;
  const maxRounds = opts.multipass ? 4 : 1;
  do { rounds++; } while (transformOnce(root, refs, runOpts, report) && rounds < maxRounds);

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
