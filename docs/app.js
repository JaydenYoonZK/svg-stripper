/*! SVG Stripper | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/svg-stripper */
import { optimize, byteLength } from "./optimizer.js?v=1.0.0";

const $ = (id) => document.getElementById(id);
const input = $("input");
const results = $("results");
const stats = $("stats");
const alerts = $("alerts");
const compare = $("compare");
const compareStage = $("compare-stage");
const imgBefore = $("img-before");
const imgAfter = $("img-after");
const wipe = $("wipe");
const renderNote = $("render-note");
const output = $("output");
const copyBtn = $("copy");
const downloadBtn = $("download");
const copyStatus = $("copy-status");
const clearBtn = $("clear");
const pasteBtn = $("paste");
const charcount = $("charcount");
const precision = $("precision");
const precisionVal = $("precision-val");
const prettify = $("prettify");
const keepMeta = $("keep-meta");

let lastOutput = "";

function currentOptions() {
  return {
    precision: Number(precision.value),
    prettify: prettify.checked,
    removeTitleDesc: !keepMeta.checked,
  };
}

// Bytes are what a server sends, so the counts are in bytes (and KB), not
// characters. A multibyte glyph in a <text> label costs more than one.
function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  return `${(n / 1024).toFixed(n < 1024 * 100 ? 1 : 0)} KB`;
}

// Real gzip size via the platform's CompressionStream, so the "gzipped" figure
// is the number that actually travels, not an estimate. Older browsers without
// it simply do not show that chip.
async function gzipSize(str) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return buf.byteLength;
  } catch {
    return null;
  }
}

const dataUri = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

function setWipe() {
  compareStage.style.setProperty("--wipe", wipe.value + "%");
}
wipe.addEventListener("input", setWipe);

let renderToken = 0;

function showControls(enabled) {
  copyBtn.disabled = !enabled;
  downloadBtn.disabled = !enabled;
}

async function run() {
  // Claim this run up front. A newer run (a fast keystroke or a slider drag)
  // bumps the token, and anything below the async gzip bails if it is stale, so
  // a late-finishing older run cannot overwrite the current stats or preview.
  const token = ++renderToken;
  const raw = input.value;
  clearBtn.disabled = raw.length === 0;
  charcount.textContent = raw.length === 0 ? "" : formatBytes(byteLength(raw));

  if (raw.trim() === "") {
    results.hidden = true;
    lastOutput = "";
    showControls(false);
    return;
  }

  const result = optimize(raw, currentOptions());
  results.hidden = false;

  if (!result.ok) {
    stats.innerHTML = "";
    compare.hidden = true;
    renderNote.textContent = "";
    output.value = "";
    lastOutput = "";
    showControls(false);
    alerts.innerHTML = `<div class="alert info" role="status">${esc(result.error)}</div>`;
    return;
  }

  lastOutput = result.svg;
  output.value = result.svg;
  showControls(true);

  // stats: original, stripped, saved, gzipped
  const savedClass = result.savedPercent > 0 ? "green" : "";
  const gz = await gzipSize(result.svg);
  if (token !== renderToken) return; // a newer run took over while gzip ran
  stats.innerHTML = [
    `<span class="chip">Original <strong>${formatBytes(result.before)}</strong></span>`,
    `<span class="chip ${savedClass ? "ok" : ""}">Stripped <strong class="${savedClass}">${formatBytes(result.after)}</strong></span>`,
    `<span class="chip">Saved <strong class="${savedClass}">${result.savedPercent}%</strong></span>`,
    gz != null ? `<span class="chip">Gzipped <strong>${formatBytes(gz)}</strong></span>` : "",
  ].join("");

  // security and info notes
  const security = result.notes.filter((n) => n.kind === "security");
  alerts.innerHTML = security.length
    ? `<div class="alert" role="alert">🛡️ <strong>Removed some code from this file.</strong> ${security.map((n) => esc(n.text)).join(" ")} The shapes are untouched.</div>`
    : "";

  // before / after preview
  renderNote.textContent = "";
  imgBefore.onerror = () => { if (token === renderToken) renderNote.textContent = "The original markup could not be rendered as an image. Check that it is a complete SVG."; };
  imgAfter.onerror = () => { if (token === renderToken) renderNote.textContent = "The stripped SVG could not be rendered, which should not happen. Please report it."; };
  imgBefore.src = dataUri(raw.trim());
  imgAfter.src = dataUri(result.svg);
  compare.hidden = false;
  setWipe();
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Optimizing is cheap, but re-rendering two images on every keystroke is not,
// so input is debounced. Explicit actions (paste, sample, options) run at once.
let debounce = 0;
input.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(run, 220);
  // keep the byte count and clear button responsive without waiting
  clearBtn.disabled = input.value.length === 0;
  charcount.textContent = input.value.length === 0 ? "" : formatBytes(byteLength(input.value));
});

for (const el of [precision, prettify, keepMeta]) {
  el.addEventListener("input", () => {
    precisionVal.textContent = precision.value;
    if (input.value.trim() !== "") run();
  });
}

pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { input.value = text; run(); input.focus(); }
  } catch {
    // Clipboard read can be blocked or unsupported; focus the box so the
    // native paste (and the iOS paste bubble) is one tap away.
    input.focus();
  }
});

clearBtn.addEventListener("click", () => {
  input.value = "";
  run();
  input.focus();
});

copyBtn.addEventListener("click", async () => {
  if (!lastOutput) return;
  let copied = false;
  try { await navigator.clipboard.writeText(lastOutput); copied = true; }
  catch {
    output.select();
    try { copied = document.execCommand("copy"); } catch { /* leave selected */ }
  }
  copyBtn.textContent = copied ? "Copied ✓" : "Copy manually";
  copyStatus.textContent = copied ? "Stripped SVG copied." : "Automatic copy failed. The SVG is selected for manual copying.";
  setTimeout(() => { copyBtn.textContent = "Copy stripped SVG"; }, 1600);
});

downloadBtn.addEventListener("click", () => {
  if (!lastOutput) return;
  const a = document.createElement("a");
  a.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(lastOutput);
  a.download = "stripped.svg";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// Drag an .svg file onto the box to load it.
["dragenter", "dragover"].forEach((type) => input.addEventListener(type, (e) => { e.preventDefault(); input.classList.add("dropping"); }));
["dragleave", "drop"].forEach((type) => input.addEventListener(type, () => input.classList.remove("dropping")));
input.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // Only read something that claims to be SVG. A dropped PNG or PDF read as
  // text would fill the box with mojibake and then fail as "not an SVG".
  if (file.type && file.type !== "image/svg+xml" && !/\.svg$/i.test(file.name)) {
    results.hidden = false;
    compare.hidden = true;
    stats.innerHTML = "";
    alerts.innerHTML = `<div class="alert info" role="status">That does not look like an SVG file. Drop an .svg, or paste the code.</div>`;
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => { alerts.innerHTML = `<div class="alert info" role="status">That file could not be read.</div>`; };
  reader.onload = () => { input.value = String(reader.result); run(); };
  reader.readAsText(file);
});

// Load a chunky Illustrator export so the tool has something to chew on.
const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.5.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px"
\t y="0px" viewBox="0 0 128 128" style="enable-background:new 0 0 128 128;" xml:space="preserve">
<style type="text/css">
\t.st0{fill:url(#SVGID_1_);}
\t.st1{fill:#FFFFFF;}
</style>
<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="64" y1="8.0000" x2="64" y2="120.0000">
\t<stop  offset="0" style="stop-color:#B6E14C"/>
\t<stop  offset="1" style="stop-color:#7EA019"/>
</linearGradient>
<path class="st0" d="M64,8.0000L16.0000,24.0000v40.0000c0,30.9280,20.4800,58.7200,48.0000,66.0000
\tc27.5200-7.2800,48.0000-35.0720,48.0000-66.0000V24.0000L64,8.0000z"/>
<path class="st1" d="M56.4000,86.8000L38.0000,68.4000l7.6000-7.6000l12.8000,12.8000l28.0000-28.0000l7.6000,7.6000
\tL56.4000,86.8000z"/>
</svg>`;
$("sample").addEventListener("click", () => { input.value = SAMPLE; run(); });

// -------- shared shell behavior (theme, scene, dust, offline, footer) --------

const toTop = $("to-top");
if (toTop) {
  addEventListener("scroll", () => toTop.classList.toggle("show", scrollY > 600), { passive: true });
  toTop.addEventListener("click", () => scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

const themeToggle = $("theme-toggle");
function syncThemeIcon() {
  const label = document.documentElement.dataset.theme === "light" ? "Switch to dark mode" : "Switch to light mode";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.setAttribute("data-tip", label);
}
let themeFadeTimer = 0;
themeToggle.addEventListener("click", () => {
  if (document.startViewTransition) {
    document.documentElement.classList.add("vt-active");
    const vt = document.startViewTransition(() => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#f6f4ee" : "#0d0c0a");
      try { localStorage.setItem("theme", next); } catch { /* storage may be blocked */ }
      syncThemeIcon();
    });
    vt.finished.finally(() => document.documentElement.classList.remove("vt-active"));
    return;
  }
  document.documentElement.classList.add("theme-fading");
  clearTimeout(themeFadeTimer);
  themeFadeTimer = setTimeout(() => document.documentElement.classList.remove("theme-fading"), 500);
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#f6f4ee" : "#0d0c0a");
  try { localStorage.setItem("theme", next); } catch { /* storage may be blocked */ }
  syncThemeIcon();
});
syncThemeIcon();

const scene = document.querySelector(".bg-scene");
if (scene && matchMedia("(pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let rafId = 0;
  addEventListener("mousemove", (e) => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      scene.style.setProperty("--px", (e.clientX / innerWidth - 0.5).toFixed(3));
      scene.style.setProperty("--py", (e.clientY / innerHeight - 0.5).toFixed(3));
    });
  }, { passive: true });
}
if (scene && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let scrollRaf = 0;
  const applyScroll = () => { scrollRaf = 0; scene.style.setProperty("--sy", String(scrollY)); };
  addEventListener("scroll", () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(applyScroll); }, { passive: true });
  applyScroll();
}

const siteNav = document.querySelector(".site-nav");
if (siteNav) {
  const setNavHeight = () => document.documentElement.style.setProperty("--nav-h", siteNav.offsetHeight + "px");
  addEventListener("resize", setNavHeight, { passive: true });
  setNavHeight();
}

// FAQ accordions: each question toggles its answer open. The card gets the
// .open class the stylesheet animates, and the button tracks aria-expanded.
document.querySelectorAll(".faq-q button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    btn.closest(".faq-item").classList.toggle("open", !open);
  });
});

// Cursor dust: tiny chartreuse sparks trail the pointer and burn out about a
// second after it rests. One fixed canvas, distance-based spawning, and the
// loop stops the moment the last spark dies. Touch and reduced-motion skip it.
(() => {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:2100;pointer-events:none;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let w = 0, h = 0;
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener("resize", size);

  const sprite = (core) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const halo = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    halo.addColorStop(0, "rgba(171, 207, 55, 0.55)");
    halo.addColorStop(0.4, "rgba(171, 207, 55, 0.16)");
    halo.addColorStop(1, "rgba(171, 207, 55, 0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = core;
    g.beginPath();
    g.arc(32, 32, 4.5, 0, 7);
    g.fill();
    return c;
  };
  const dust = { dark: sprite("#d7ef7a"), light: sprite("#7e9c26") };

  const sparks = [];
  const MAX = 90;
  let raf = 0, prev = 0, lastX = -1, lastY = -1, carry = 0;

  const spawn = (x, y, dx, dy) => {
    if (sparks.length >= MAX) return;
    const a = Math.random() * Math.PI * 2;
    const push = 4 + Math.random() * 16;
    sparks.push({
      x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8,
      vx: Math.cos(a) * push + dx * 1.4, vy: Math.sin(a) * push + dy * 1.4,
      life: 0, ttl: 0.45 + Math.random() * 0.5, r: 5 + Math.random() * 9,
      star: Math.random() < 0.25, rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 4, seed: Math.random() * 40
    });
  };
  const star = (R) => {
    ctx.beginPath();
    ctx.moveTo(0, -R);
    ctx.quadraticCurveTo(R * 0.16, -R * 0.16, R, 0);
    ctx.quadraticCurveTo(R * 0.16, R * 0.16, 0, R);
    ctx.quadraticCurveTo(-R * 0.16, R * 0.16, -R, 0);
    ctx.quadraticCurveTo(-R * 0.16, -R * 0.16, 0, -R);
    ctx.fill();
  };
  const tick = (now) => {
    const t = now / 1000;
    const dt = Math.min(0.05, prev ? t - prev : 0.016);
    prev = t;
    ctx.clearRect(0, 0, w, h);
    const light = document.documentElement.dataset.theme === "light";
    const img = light ? dust.light : dust.dark;
    ctx.fillStyle = light ? "#7e9c26" : "#d7ef7a";
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life >= s.ttl) { sparks.splice(i, 1); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.9; s.vy = s.vy * 0.9 + 26 * dt;
      const k = 1 - s.life / s.ttl;
      const twinkle = 0.7 + 0.3 * Math.sin(t * 16 + s.seed);
      ctx.globalAlpha = k * k * twinkle;
      const R = s.r * (0.5 + 0.7 * k);
      ctx.drawImage(img, s.x - R, s.y - R, R * 2, R * 2);
      if (s.star) { s.rot += s.spin * dt; ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot); star(R * 0.9); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
    if (sparks.length) raf = requestAnimationFrame(tick);
    else { raf = 0; prev = 0; ctx.clearRect(0, 0, w, h); }
  };
  addEventListener("pointermove", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (lastX < 0) { lastX = e.clientX; lastY = e.clientY; return; }
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    carry += Math.hypot(dx, dy);
    while (carry > 10) { carry -= 10; spawn(e.clientX, e.clientY, dx, dy); }
    if (sparks.length && !raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
})();

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/svg-stripper/sw.js").catch(() => { /* offline support is optional */ });
  });
}

console.info(
  "%cBuilt by Jayden Yoon ZK%c https://github.com/JaydenYoonZK",
  "background:#abcf37;color:#101400;font-weight:700;padding:2px 8px;border-radius:999px",
  "color:inherit"
);

const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.querySelectorAll("svg").forEach((el) => el.pauseAnimations?.());
}
