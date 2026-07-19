/*! SVG Stripper | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/svg-stripper */
import { optimize, byteLength, listPaints, applyRecolor } from "./optimizer.js?v=1.4.2";

const $ = (id) => document.getElementById(id);
const input = $("input");
const results = $("results");
const resultBody = $("result-body");
const stats = $("stats");
const alerts = $("alerts");
const compare = $("compare");
const compareStage = $("compare-stage");
const imgBefore = $("img-before");
const imgAfter = $("img-after");
const divider = $("compare-divider");
const colorsSection = $("colors");
const colorEditor = $("color-editor");
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

// The wipe divider. Drag it, click anywhere on the stage to jump it, or focus
// it and use the arrow keys. Before sits on the left, the stripped After on the
// right, so dragging right reveals more of your original.
let wipePct = 55;
function setWipe(pct) {
  wipePct = Math.max(0, Math.min(100, pct));
  compareStage.style.setProperty("--wipe", wipePct + "%");
  divider.setAttribute("aria-valuenow", String(Math.round(wipePct)));
  divider.setAttribute("aria-valuetext", Math.round(wipePct) + "% of the original shown");
}
function pctFromClientX(clientX) {
  const rect = compareStage.getBoundingClientRect();
  return rect.width ? ((clientX - rect.left) / rect.width) * 100 : wipePct;
}
let dragging = false;
compareStage.addEventListener("pointerdown", (e) => {
  dragging = true;
  compareStage.setPointerCapture?.(e.pointerId);
  divider.focus?.({ preventScroll: true });
  setWipe(pctFromClientX(e.clientX));
  e.preventDefault();
});
compareStage.addEventListener("pointermove", (e) => { if (dragging) setWipe(pctFromClientX(e.clientX)); });
compareStage.addEventListener("pointerup", () => { dragging = false; });
compareStage.addEventListener("pointercancel", () => { dragging = false; });
divider.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 10 : 2;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setWipe(wipePct - step); e.preventDefault(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") { setWipe(wipePct + step); e.preventDefault(); }
  else if (e.key === "Home") { setWipe(0); e.preventDefault(); }
  else if (e.key === "End") { setWipe(100); e.preventDefault(); }
});

// Preview background: the checkerboard (transparency) by default, or a solid
// color, so a logo that is hard to read on the checker can be checked on the
// background it will actually sit on.
const previewBg = document.querySelector(".preview-bg");
if (previewBg) {
  const setBg = (mode, active) => {
    previewBg.querySelectorAll(".bg-opt").forEach((b) => {
      const on = b === active;
      b.classList.toggle("is-active", on);
      if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", String(on));
    });
    if (mode === "checker") compareStage.classList.remove("solid");
    else { compareStage.style.setProperty("--preview-bg", mode); compareStage.classList.add("solid"); }
  };
  previewBg.querySelectorAll("button.bg-opt").forEach((btn) => btn.addEventListener("click", () => {
    if (btn.classList.contains("is-active")) return; // already the current background
    setBg(btn.dataset.bg, btn);
  }));
  const bgCustom = $("bg-custom");
  if (bgCustom) {
    const chip = bgCustom.closest(".bg-opt");
    // Apply the stored color the moment the chip is tapped: a color input
    // fires no event when the picker confirms an unchanged value, so without
    // this, re-choosing the same custom color would do nothing at all.
    chip.addEventListener("click", () => setBg(bgCustom.value, chip));
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBg(bgCustom.value, chip); bgCustom.click(); }
    });
    bgCustom.addEventListener("input", () => setBg(bgCustom.value, chip));
  }
  // Sync the initial locked state for whichever chip starts active.
  const initialBg = previewBg.querySelector("button.bg-opt.is-active");
  if (initialBg) setBg(initialBg.dataset.bg, initialBg);
}

let renderToken = 0;
let base = "";      // the stripped SVG, before any recolor
let recolor = {};   // key (a color string, or grad:<id>:<index>) -> chosen color
let originalBytes = 0;

function showControls(enabled) {
  copyBtn.disabled = !enabled;
  downloadBtn.disabled = !enabled;
}

// Render the final SVG (stripped, then recolored) into the output, the After
// image, and the stats. Token-guarded so a stale async gzip cannot overwrite a
// newer run.
async function renderResult(final, token) {
  lastOutput = final;
  output.value = final;
  showControls(true);
  renderNote.textContent = "";
  // The failure note is guarded by THIS render's token. Assigned here rather
  // than in run(), because recolor renders bump the token too and would
  // otherwise silently mute a genuine failure.
  imgAfter.onerror = () => { if (token === renderToken) renderNote.textContent = "The stripped SVG could not be rendered, which should not happen. Please report it via the Report an issue link in the footer."; };
  imgAfter.src = dataUri(final);
  compare.hidden = false;
  setWipe(wipePct);

  const after = byteLength(final);
  const savedPercent = originalBytes === 0 ? 0 : Math.round(((originalBytes - after) / originalBytes) * 1000) / 10;
  const savedClass = savedPercent > 0 ? "green" : "";
  const gz = await gzipSize(final);
  if (token !== renderToken) return;
  stats.innerHTML = [
    `<span class="chip">Original <strong>${formatBytes(originalBytes)}</strong></span>`,
    `<span class="chip ${savedClass ? "ok" : ""}">Stripped <strong class="${savedClass}">${formatBytes(after)}</strong></span>`,
    `<span class="chip">Saved <strong class="${savedClass}">${savedPercent}%</strong></span>`,
    gz != null ? `<span class="chip">Gzipped <strong>${formatBytes(gz)}</strong></span>` : "",
  ].join("");
}

// Re-apply the current color choices to the base and re-render, without
// rebuilding the editor, so an open field keeps focus.
function applyColorsAndRender() {
  if (!base) return;
  renderResult(applyRecolor(base, recolor, currentOptions()), ++renderToken);
}

// Coalesce recolor renders to one per frame. A native color wheel fires input
// continuously while dragging, and each render re-serializes the whole SVG and
// re-rasters the preview, which is wasted work more than once a frame.
let recolorRaf = 0;
function scheduleColorRender() {
  if (recolorRaf) return;
  recolorRaf = requestAnimationFrame(() => { recolorRaf = 0; applyColorsAndRender(); });
}

async function run() {
  const token = ++renderToken;
  const raw = input.value;
  clearBtn.disabled = raw.length === 0;
  charcount.textContent = raw.length === 0 ? "" : formatBytes(byteLength(raw));

  if (raw.trim() === "") {
    results.hidden = true;
    colorsSection.hidden = true;
    lastOutput = "";
    base = "";
    showControls(false);
    return;
  }

  const result = optimize(raw, currentOptions());
  results.hidden = false;

  if (!result.ok) {
    // Hide the whole result scaffold, not just the preview: headings, dead
    // action keys, and an empty output box under an error read as breakage.
    resultBody.hidden = true;
    stats.innerHTML = "";
    compare.hidden = true;
    colorsSection.hidden = true;
    renderNote.textContent = "";
    output.value = "";
    lastOutput = "";
    base = "";
    showControls(false);
    alerts.innerHTML = `<div class="alert info" role="status">${esc(result.error)}</div>`;
    return;
  }

  resultBody.hidden = false;
  base = result.svg;
  originalBytes = result.before;
  buildColorEditor(listPaints(base));

  const security = result.notes.filter((n) => n.kind === "security");
  alerts.innerHTML = security.length
    ? `<div class="alert" role="alert">🛡️ <strong>Removed some code from this file.</strong> ${security.map((n) => esc(n.text)).join(" ")} The shapes are untouched.</div>`
    : "";

  renderNote.textContent = "";
  imgBefore.onerror = () => { if (token === renderToken) renderNote.textContent = "The original markup could not be rendered as an image. Check that it is a complete SVG."; };
  imgBefore.src = dataUri(raw.trim());
  await renderResult(applyRecolor(base, recolor, currentOptions()), token);
}

function esc(s) {
  // Escapes for both text content and double-quoted attributes (color labels
  // and gradient ids from a pasted SVG flow into data- attributes).
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Optimizing is cheap, but re-rendering two images on every keystroke is not,
// so input is debounced. Explicit actions (paste, sample, options) run at once.
let debounce = 0;
input.addEventListener("input", () => {
  recolor = {}; // a new SVG has its own colors; start the recolor over
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

// The paste button always answers: filled box, "empty" notice, or plain
// instructions for a manual paste. A silent click reads as a dead button.
const pasteLabel = pasteBtn.textContent;
let pasteFlashTimer = 0, waitingForPaste = false;
function flashPaste(msg) {
  pasteBtn.textContent = msg;
  clearTimeout(pasteFlashTimer);
  pasteFlashTimer = setTimeout(() => { pasteBtn.textContent = pasteLabel; }, 2600);
}
pasteBtn.addEventListener("click", async () => {
  // Read the clipboard on every device. On iOS the system shows its Paste
  // confirmation bubble at the tap point; confirming it fills the box in one
  // motion. That bubble is the minimum iOS allows before a page may read.
  try {
    const text = await navigator.clipboard.readText();
    if (text) { recolor = {}; input.value = text; run(); input.focus(); return; }
    flashPaste("Clipboard is empty");
    return;
  } catch { /* declined or unsupported, fall back to a manual paste */ }
  waitingForPaste = true;
  input.focus();
  input.select(); // a manual paste then replaces the old content
  flashPaste(matchMedia("(pointer: coarse)").matches
    ? "Long-press the box, then Paste"
    : (navigator.platform?.includes("Mac") ? "Press ⌘V to paste" : "Press Ctrl+V to paste"));
});
input.addEventListener("paste", () => {
  if (!waitingForPaste) return;
  waitingForPaste = false;
  clearTimeout(pasteFlashTimer);
  pasteBtn.textContent = pasteLabel;
});

clearBtn.addEventListener("click", () => {
  recolor = {};
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
  if (!file) {
    // Not a file: someone dragged selected text (SVG markup from an editor,
    // say). preventDefault above cancels the native insertion, so do it here.
    const text = e.dataTransfer?.getData("text/plain");
    if (text) { recolor = {}; input.value = text; run(); }
    return;
  }
  // Only read something that claims to be SVG. A dropped PNG or PDF read as
  // text would fill the box with mojibake and then fail as "not an SVG".
  // The notice is additive: whatever result is already on screen is still
  // valid, since a rejected drop changes nothing.
  if (file.type && file.type !== "image/svg+xml" && !/\.svg$/i.test(file.name)) {
    results.hidden = false;
    alerts.innerHTML = `<div class="alert info" role="status">That does not look like an SVG file. Drop an .svg, or paste the code.</div>`;
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => {
    results.hidden = false;
    alerts.innerHTML = `<div class="alert info" role="status">That file could not be read.</div>`;
  };
  reader.onload = () => { recolor = {}; input.value = String(reader.result); run(); };
  reader.readAsText(file);
});

// Load a chunky Illustrator export so the tool has something to chew on.
const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.5.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px"
\t y="0px" width="128px" height="128px" viewBox="0 0 128 128" enable-background="new 0 0 128 128" xml:space="preserve">
<metadata>
\t<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"
\t\t\txmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
\t\t<rdf:Description rdf:about="" dc:format="image/svg+xml">
\t\t\t<dc:title>verified-badge-final-v3 copy 2</dc:title>
\t\t\t<xmp:CreatorTool>Adobe Illustrator 27.5 (Macintosh)</xmp:CreatorTool>
\t\t\t<xmp:CreateDate>2026-07-11T14:02:31+08:00</xmp:CreateDate>
\t\t\t<xmpMM:DocumentID>xmp.did:F77F117407206811822AC5959f342E9c</xmpMM:DocumentID>
\t\t\t<xmpMM:InstanceID>xmp.iid:F77F117407206811822AC5959f342E9c</xmpMM:InstanceID>
\t\t</rdf:Description>
\t</rdf:RDF>
</metadata>
<style type="text/css">
\t.st0{fill:url(#SVGID_1_);}
\t.st1{fill:none;stroke:#FFFFFF;stroke-width:11;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4;}
</style>
<defs>
</defs>
<g id="Layer_1_1_">
\t<g id="Badge_x5F_seal" data-name="Badge seal">
\t\t<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="64.0000" y1="9.0000" x2="64.0000" y2="119.0000" gradientTransform="matrix(1 0 0 1 0 0)">
\t\t\t<stop  offset="0" style="stop-color:#B6E14C"/>
\t\t\t<stop  offset="1" style="stop-color:#7EA019"/>
\t\t</linearGradient>
\t\t<path class="st0" fill-rule="nonzero" clip-rule="nonzero" d="M119.0000,64.0000C119.0000,65.5999,117.7409,67.1833,115.8021,68.5321
\t\tC113.8634,69.8809,111.3198,70.9850,109.3012,71.9878C107.2826,72.9906,105.8585,73.9210,105.5348,75.1292
\t\tC105.2111,76.3374,105.9791,77.8552,107.2259,79.7329C108.4726,81.6107,110.1234,83.8387,111.1280,85.9761
\t\tC112.1326,88.1136,112.4313,90.1145,111.6314,91.5000C110.8315,92.8855,108.9493,93.6273,106.5959,93.8260
\t\tC104.2425,94.0247,101.4876,93.7091,99.2380,93.5682C96.9885,93.4274,95.2901,93.5211,94.4056,94.4056
\t\tC93.5211,95.2901,93.4274,96.9885,93.5682,99.2380C93.7091,101.4876,94.0247,104.2425,93.8260,106.5959
\t\tC93.6273,108.9493,92.8855,110.8315,91.5000,111.6314C90.1145,112.4313,88.1136,112.1326,85.9761,111.1280
\t\tC83.8387,110.1234,81.6107,108.4726,79.7329,107.2259C77.8552,105.9791,76.3374,105.2111,75.1292,105.5348
\t\tC73.9210,105.8585,72.9906,107.2826,71.9878,109.3012C70.9850,111.3198,69.8809,113.8634,68.5321,115.8021
\t\tC67.1833,117.7409,65.5999,119.0000,64.0000,119.0000C62.4001,119.0000,60.8167,117.7409,59.4679,115.8021
\t\tC58.1191,113.8634,57.0150,111.3198,56.0122,109.3012C55.0094,107.2826,54.0790,105.8585,52.8708,105.5348
\t\tC51.6626,105.2111,50.1448,105.9791,48.2671,107.2259C46.3893,108.4726,44.1613,110.1234,42.0239,111.1280
\t\tC39.8864,112.1326,37.8855,112.4313,36.5000,111.6314C35.1145,110.8315,34.3727,108.9493,34.1740,106.5959
\t\tC33.9753,104.2425,34.2909,101.4876,34.4318,99.2380C34.5726,96.9885,34.4789,95.2901,33.5944,94.4056
\t\tC32.7099,93.5211,31.0115,93.4274,28.7620,93.5682C26.5124,93.7091,23.7575,94.0247,21.4041,93.8260
\t\tC19.0507,93.6273,17.1685,92.8855,16.3686,91.5000C15.5687,90.1145,15.8674,88.1136,16.8720,85.9761
\t\tC17.8766,83.8387,19.5274,81.6107,20.7741,79.7329C22.0209,77.8552,22.7889,76.3374,22.4652,75.1292
\t\tC22.1415,73.9210,20.7174,72.9906,18.6988,71.9878C16.6802,70.9850,14.1366,69.8809,12.1979,68.5321
\t\tC10.2591,67.1833,9.0000,65.5999,9.0000,64.0000C9.0000,62.4001,10.2591,60.8167,12.1979,59.4679
\t\tC14.1366,58.1191,16.6802,57.0150,18.6988,56.0122C20.7174,55.0094,22.1415,54.0790,22.4652,52.8708
\t\tC22.7889,51.6626,22.0209,50.1448,20.7741,48.2671C19.5274,46.3893,17.8766,44.1613,16.8720,42.0239
\t\tC15.8674,39.8864,15.5687,37.8855,16.3686,36.5000C17.1685,35.1145,19.0507,34.3727,21.4041,34.1740
\t\tC23.7575,33.9753,26.5124,34.2909,28.7620,34.4318C31.0115,34.5726,32.7099,34.4789,33.5944,33.5944
\t\tC34.4789,32.7099,34.5726,31.0115,34.4318,28.7620C34.2909,26.5124,33.9753,23.7575,34.1740,21.4041
\t\tC34.3727,19.0507,35.1145,17.1685,36.5000,16.3686C37.8855,15.5687,39.8864,15.8674,42.0239,16.8720
\t\tC44.1613,17.8766,46.3893,19.5274,48.2671,20.7741C50.1448,22.0209,51.6626,22.7889,52.8708,22.4652
\t\tC54.0790,22.1415,55.0094,20.7174,56.0122,18.6988C57.0150,16.6802,58.1191,14.1366,59.4679,12.1979
\t\tC60.8167,10.2591,62.4001,9.0000,64.0000,9.0000C65.5999,9.0000,67.1833,10.2591,68.5321,12.1979
\t\tC69.8809,14.1366,70.9850,16.6802,71.9878,18.6988C72.9906,20.7174,73.9210,22.1415,75.1292,22.4652
\t\tC76.3374,22.7889,77.8552,22.0209,79.7329,20.7741C81.6107,19.5274,83.8387,17.8766,85.9761,16.8720
\t\tC88.1136,15.8674,90.1145,15.5687,91.5000,16.3686C92.8855,17.1685,93.6273,19.0507,93.8260,21.4041
\t\tC94.0247,23.7575,93.7091,26.5124,93.5682,28.7620C93.4274,31.0115,93.5211,32.7099,94.4056,33.5944
\t\tC95.2901,34.4789,96.9885,34.5726,99.2380,34.4318C101.4876,34.2909,104.2425,33.9753,106.5959,34.1740
\t\tC108.9493,34.3727,110.8315,35.1145,111.6314,36.5000C112.4313,37.8855,112.1326,39.8864,111.1280,42.0239
\t\tC110.1234,44.1613,108.4726,46.3893,107.2259,48.2671C105.9791,50.1448,105.2111,51.6626,105.5348,52.8708
\t\tC105.8585,54.0790,107.2826,55.0094,109.3012,56.0122C111.3198,57.0150,113.8634,58.1191,115.8021,59.4679
\t\tC117.7409,60.8167,119.0000,62.4001,119.0000,64.0000z"/>
\t</g>
\t<g id="Check_x5F_mark" data-name="Check mark">
\t\t<path class="st1" stroke-dasharray="none" d="M46.0000,64.5000L57.0000,76.0000
\t\t\tL85.0000,47.0000"/>
\t</g>
</g>
</svg>`;
$("sample").addEventListener("click", () => { recolor = {}; input.value = SAMPLE; run(); });

// The JaydenART wordmark: a real Adobe Illustrator export with ten linked
// gradients (some inheriting others via xlink:href) and eleven CSS classes.
const LOGO_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<svg id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" viewBox="0 0 4098.22 725.7">
  <!-- Generator: Adobe Illustrator 30.6.0, SVG Export Plug-In . SVG Version: 2.1.4 Build 109)  -->
  <defs>
    <style>
      .st0 { fill: url(#linear-gradient2); }
      .st1 { fill: url(#linear-gradient1); }
      .st2 { fill: url(#linear-gradient9); }
      .st3 { fill: url(#linear-gradient3); }
      .st4 { fill: url(#linear-gradient6); }
      .st5 { fill: url(#linear-gradient8); }
      .st6 { fill: url(#linear-gradient7); }
      .st7 { fill: url(#linear-gradient5); }
      .st8 { fill: url(#linear-gradient4); }
      .st9 { fill: url(#linear-gradient); }
      .st10 { fill: #fff; }
    </style>
    <linearGradient id="linear-gradient" x1="362.85" y1="0" x2="362.85" y2="1201.04" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#abcf37"/>
      <stop offset="1" stop-color="#5f7a1b"/>
    </linearGradient>
    <linearGradient id="linear-gradient1" x1="1030" y1="128.91" x2="1030" y2="564.87" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#66564f"/>
      <stop offset=".37" stop-color="#524640"/>
      <stop offset="1" stop-color="#2b2d2d"/>
    </linearGradient>
    <linearGradient id="linear-gradient2" x1="1352.15" y1="219.08" x2="1352.15" y2="565.53" xlink:href="#linear-gradient1"/>
    <linearGradient id="linear-gradient3" x1="1679.55" y1="223.9" x2="1679.55" y2="688.75" xlink:href="#linear-gradient1"/>
    <linearGradient id="linear-gradient4" x1="2010.91" x2="2010.91" y2="563.12" xlink:href="#linear-gradient1"/>
    <linearGradient id="linear-gradient5" x1="2367.9" y1="219.08" x2="2367.9" y2="565.76" xlink:href="#linear-gradient1"/>
    <linearGradient id="linear-gradient6" x1="2702.29" y1="218.66" x2="2702.29" y2="557.88" xlink:href="#linear-gradient1"/>
    <linearGradient id="linear-gradient7" x1="3099.43" y1="128.91" x2="3099.43" y2="557.88" gradientUnits="userSpaceOnUse">
      <stop offset=".12" stop-color="#3a3c3b"/>
      <stop offset=".56" stop-color="#252323"/>
      <stop offset="1" stop-color="#231f20"/>
    </linearGradient>
    <linearGradient id="linear-gradient8" x1="3534.5" x2="3534.5" xlink:href="#linear-gradient7"/>
    <linearGradient id="linear-gradient9" x1="3924.51" x2="3924.51" y2="557.42" xlink:href="#linear-gradient7"/>
  </defs>
  <g>
    <path class="st9" d="M705.7,725.7H20c-11,0-20-9-20-20V20C0,9,9,0,20,0h685.7c11,0,20,9,20,20v685.7c0,11-9,20-20,20Z"/>
    <g>
      <path class="st10" d="M624,70.2H100.9c-17,0-30.7,13.7-30.7,30.7v450c0,19.4,16.7,34.5,35.9,32.3,56-6.2,157.2-31.6,157.2-105.3,0-44.8-.4-69.9-.2-103.9.1-17.7,14.4-31.9,32.1-31.9h134.2c18.3,0,33.1,14.8,33.1,33.1v129.2s0,151.2-132.2,151.2c0,0,325.1,11.5,325.1-160.7V101.6c0-17.3-14.1-31.4-31.4-31.4ZM462.6,245.8c0,9.9-8.1,18-18,18h-163.4c-9.9,0-18-8.1-18-18v-79.5c0-9.9,8.1-18,18-18h163.4c9.9,0,18,8.1,18,18v79.5Z"/>
      <path class="st10" d="M367,207v-.3c3.4-1,5.7-3.4,5.7-6.4,0-2.7-1.2-4.8-2.7-6-2-1.2-4.3-2-9.5-2-4.6,0-8.1.3-10.6.8v27.5h6.3v-11.1h3c3.5,0,5.2,1.4,5.7,4.4.9,3.2,1.4,5.7,2.2,6.7h6.9c-.7-1-1.2-2.7-2-6.9-.8-3.7-2.3-5.7-5-6.7ZM359.5,205h-3v-7.9c.7-.1,1.8-.3,3.5-.3,4.1,0,5.9,1.7,5.9,4.2,0,2.8-2.9,4-6.4,4Z"/>
      <path class="st10" d="M360.7,178.7c-15.7,0-28.3,11.9-28.3,27.5s12.4,27.8,28.3,27.8,28.1-12.2,28.1-27.8-12.2-27.4-28.1-27.5ZM360.8,228.1c-12.4,0-21.4-9.7-21.4-21.9h0c0-12.1,9-22,21.2-22s21.1,10,21.1,22.1-8.5,21.8-20.9,21.8Z"/>
    </g>
  </g>
  <g>
    <path class="st1" d="M1077.93,174.43v269.63c0,32.82-15.76,49.02-48.15,49.02-34.58,0-51.65-15.32-51.65-45.52v-51.65h-84.04v33.27c0,31.95,1.75,52.96,6.13,63.03,15.32,51.21,66.98,72.66,130.88,72.66s115.12-21.89,129.56-76.6c3.5-16.63,5.25-36.77,5.25-59.53V128.91h-43.77c-24.08,0-44.21,21.45-44.21,45.52Z"/>
    <path class="st0" d="M1351.94,219.08c-77.04,0-120.81,30.64-130.88,92.36h84.05c4.37-15.76,21.01-23.64,50.77-22.76,34.58,0,52.53,9.63,54.28,28.45,0,18.39-18.39,28.89-54.28,33.27-84.48,8.32-142.7,29.77-144.45,109.87,0,73.53,55.59,110.74,135.69,104.61,90.17-6.57,145.76-47.27,145.76-139.63v-113.81c-2.19-62.16-48.58-92.36-140.94-92.36ZM1411.47,421.3c0,47.27-28.45,74.85-74.85,74.85-26.7,0-40.71-12.26-42.46-38.96,0-24.95,17.07-40.71,50.34-46.84,24.51-4.81,47.27-11.81,66.97-20.13v31.08Z"/>
    <path class="st3" d="M1740.18,253.66l-58.22,201.79-66.09-231.55h-95.42l113.81,326.53c13.57,44.21-3.06,66.97-49.02,66.97h-.01s-23.64,0-23.64,0v68.72c2.62,2.19,14,2.63,35.45,2.63,69.6,0,89.74-18.82,109.87-73.97l131.75-390.88h-58.65c-21.45,0-34.58,10.06-39.83,29.76Z"/>
    <path class="st8" d="M2124.93,128.91h-41.58v141.82c-21.45-34.58-53.84-51.65-95.42-51.65-88.85,3.07-133.06,63.48-133.06,174.65s51.65,167.64,155.39,169.39c104.17.44,156.7-49.46,156.7-149.7v-242.49h-.01c0-22.76-18.82-42.02-42.02-42.02ZM2012.01,491.78c-48.14,0-70.47-34.14-70.03-101.55h0c2.19-64.34,25.83-95.86,71.35-95.86s68.72,31.52,70.47,95.86c0,67.41-23.64,101.55-71.78,101.55Z"/>
    <path class="st7" d="M2369.18,219.08c-101.55.88-152.76,57.35-152.76,171.15s50.34,172.46,151.45,175.52h0c82.29.01,127.81-39.39,145.76-109.86h-61.72c-11.38,0-21.01,3.5-28.45,11.82-16.2,15.75-34.58,24.07-54.28,24.07-40.7,0-63.03-25.83-66.09-77.04h215.79c6.13-130.88-43.77-195.66-149.7-195.66ZM2304.4,354.77h0c6.13-44.21,28.02-66.97,63.91-66.97s56.47,22.76,61.72,66.97h-125.62Z"/>
    <path class="st4" d="M2703.16,218.66c-94.98,0-143.13,47.27-143.13,142.69v196.53h85.35v-213.17c.87-34.58,19.69-51.65,56.9-51.65s56.47,17.07,58.22,51.65v171.58c0,26.26,14,39.83,41.58,41.58h0s42.46,0,42.46,0v-196.53c.44-95.42-46.4-142.69-141.38-142.69Z"/>
  </g>
  <g>
    <path class="st6" d="M3151.07,128.91h-72.02c-21.75,0-35.79,9.52-42.13,28.54l-145.86,400.43h95.58l28.99-87.42h168.96l28.99,87.42h94.22l-156.73-428.97h0ZM3159.22,397.53h-120.03l59.79-182.09,60.24,182.09Z"/>
    <path class="st5" d="M3700.06,529.33l-4.08-83.8c-2.27-28.09-5.89-49.38-13.59-63.87-9.06-13.13-23.1-23.1-41.67-29.44,41.67-11.32,65.68-46.65,64.77-101.01,0-88.33-49.83-122.3-140.42-122.3h-165.33c-24.91,0-44.84,21.74-44.84,46.2v382.77h89.23v-166.24h95.12c52.55,0,62.06,16.3,65.23,67.94.91,41.67,2.27,66.13,4.08,72.47.91,8.61,2.72,17.67,7.25,25.82h98.29c-8.15-5.89-13.59-15.4-14.04-28.54ZM3549.68,316.44h-105.09v-112.79h110.52c39.41,0,60.7,16.76,60.7,56.17,0,41.67-23.55,56.62-66.13,56.62Z"/>
    <path class="st2" d="M3796.09,128.91c-25.37,0-44.85,21.74-45.3,46.2v29.9h129.1v352.41h89.23V205.01h129.1v-76.1h-302.13Z"/>
  </g>
</svg>`;
$("sample-logo").addEventListener("click", () => { recolor = {}; input.value = LOGO_SAMPLE; run(); });

/* ---------- color editor ---------- */

function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }
function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) { return "#" + [r, g, b].map((x) => clamp255(x).toString(16).padStart(2, "0")).join(""); }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  if (s === 0) { const v = clamp255(l * 255); return { r: v, g: v, b: v }; }
  const hue = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return { r: clamp255(hue(p, q, h + 1 / 3) * 255), g: clamp255(hue(p, q, h) * 255), b: clamp255(hue(p, q, h - 1 / 3) * 255) };
}
function rgbToCmyk(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: Math.round((1 - r - k) / (1 - k) * 100), m: Math.round((1 - g - k) / (1 - k) * 100), y: Math.round((1 - b - k) / (1 - k) * 100), k: Math.round(k * 100) };
}
function cmykToRgb(c, m, y, k) {
  c /= 100; m /= 100; y /= 100; k /= 100;
  return { r: clamp255(255 * (1 - c) * (1 - k)), g: clamp255(255 * (1 - m) * (1 - k)), b: clamp255(255 * (1 - y) * (1 - k)) };
}
function shortHex(hex) {
  const h = hex.toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(h) && h[1] === h[2] && h[3] === h[4] && h[5] === h[6]) return "#" + h[1] + h[3] + h[5];
  return h;
}
// Resolve any CSS color (hex, rgb, hsl, or a name) to a 6-digit hex, or null if
// it is not a literal color a swatch can show. Named colors resolve through the
// canvas, checked against two sentinels so an invalid name is not read as black.
function colorToHex(v) {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  if (/^#[0-9a-f]{4}$/.test(s)) return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return rgbToHex(+m[1], +m[2], +m[3]);
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/.exec(s);
  if (m) { const c = hslToRgb(+m[1], +m[2], +m[3]); return rgbToHex(c.r, c.g, c.b); }
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#123456"; ctx.fillStyle = s; const a = ctx.fillStyle;
    ctx.fillStyle = "#654321"; ctx.fillStyle = s; const b = ctx.fillStyle;
    if (a === b) { if (a[0] === "#") return a; const mm = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(a); if (mm) return rgbToHex(+mm[1], +mm[2], +mm[3]); }
  } catch { /* canvas unavailable */ }
  return null;
}
// The alpha channel of a paint, as two hex digits, or "" when fully opaque.
// A color input can only express opaque colors, so a translucent original's
// alpha is carried alongside and re-attached to whatever the user picks;
// without this, recoloring a 50% shadow would silently turn it solid.
function alphaHexOf(v) {
  const s = String(v || "").trim();
  let m = /^#([0-9a-fA-F]{8})$/.exec(s);
  if (m) { const a = m[1].slice(6).toLowerCase(); return a === "ff" ? "" : a; }
  m = /^#([0-9a-fA-F]{4})$/.exec(s);
  if (m) { const a = m[1][3].toLowerCase(); return a === "f" ? "" : a + a; }
  m = /^(?:rgba|hsla)\([^)]*[,/]\s*([0-9.]+%?)\s*\)$/i.exec(s);
  if (m) {
    const a = m[1].endsWith("%") ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    if (isFinite(a) && a >= 0 && a < 1) return Math.round(a * 255).toString(16).padStart(2, "0");
  }
  return "";
}

function parseFormat(fmt, value) {
  const v = value.trim();
  if (fmt === "hex") return colorToHex(v.startsWith("#") ? v : "#" + v);
  const nums = v.match(/-?\d*\.?\d+/g);
  if (!nums) return null;
  if (fmt === "rgb" && nums.length >= 3) return rgbToHex(+nums[0], +nums[1], +nums[2]);
  if (fmt === "hsl" && nums.length >= 3) { const c = hslToRgb(+nums[0], +nums[1], +nums[2]); return rgbToHex(c.r, c.g, c.b); }
  if (fmt === "cmyk" && nums.length >= 4) { const c = cmykToRgb(+nums[0], +nums[1], +nums[2], +nums[3]); return rgbToHex(c.r, c.g, c.b); }
  return null;
}
const offsetPct = (offset) => {
  const p = offset && offset.includes("%") ? parseFloat(offset) : parseFloat(offset) * 100;
  return isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0;
};

function buildColorEditor(paints) {
  const colors = paints.colors.filter((c) => colorToHex(c.value));
  const gradients = paints.gradients.filter((g) => g.stops.some((s) => colorToHex(s.color)));
  if (colors.length === 0 && gradients.length === 0) { colorsSection.hidden = true; colorEditor.innerHTML = ""; return; }
  colorsSection.hidden = false;

  let html = `<p class="color-hint">Tap a swatch to open the color wheel. Solid colors take typed HEX, RGB, HSL, or CMYK; gradient stops take HEX.</p><div class="color-editor-head"><button type="button" class="color-reset" id="color-reset"${Object.keys(recolor).length ? "" : " disabled"}>Reset colors</button></div>`;

  for (const c of colors) {
    const cur = colorToHex(recolor[c.value]) || colorToHex(c.value);
    const rgb = hexToRgb(cur), hsl = rgbToHsl(rgb.r, rgb.g, rgb.b), cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b);
    const label = esc(c.value);
    const alpha = alphaHexOf(c.value);
    html += `<div class="color-row" data-key="${label}"${alpha ? ` data-alpha="${alpha}"` : ""}>
      <span class="swatch-wrap"><input type="color" class="color-swatch" data-key="${label}" value="${cur}" aria-label="Color for ${label}"><span class="swatch-cue" aria-hidden="true"></span></span>
      <div class="color-name">${label}<small>${c.uses} part${c.uses > 1 ? "s" : ""}</small></div>
      <div class="color-fields">
        <label class="color-field hex">Hex<input type="text" data-fmt="hex" value="${shortHex(cur)}" spellcheck="false" aria-label="Hex for ${label}"></label>
        <label class="color-field rgb">RGB<input type="text" data-fmt="rgb" value="${rgb.r}, ${rgb.g}, ${rgb.b}" spellcheck="false" aria-label="RGB for ${label}"></label>
        <label class="color-field hsl">HSL<input type="text" data-fmt="hsl" value="${hsl.h}, ${hsl.s}%, ${hsl.l}%" spellcheck="false" aria-label="HSL for ${label}"></label>
        <label class="color-field cmyk">CMYK<input type="text" data-fmt="cmyk" value="${cmyk.c}, ${cmyk.m}, ${cmyk.y}, ${cmyk.k}" spellcheck="false" aria-label="CMYK for ${label}"></label>
      </div>
    </div>`;
  }

  for (const g of gradients) {
    const stopBits = g.stops.map((s) => {
      const cur = colorToHex(recolor[`grad:${g.id}:${s.index}`]) || colorToHex(s.color) || "#000000";
      const pct = offsetPct(s.offset);
      return { key: `grad:${g.id}:${s.index}`, cur, pct, alpha: alphaHexOf(s.color) };
    });
    const bar = stopBits.map((b) => `${b.cur} ${b.pct}%`).join(", ");
    const stopsHtml = stopBits.map((b) =>
      `<div class="gradient-stop" data-key="${esc(b.key)}"${b.alpha ? ` data-alpha="${b.alpha}"` : ""}><label class="swatch-wrap"><input type="color" class="color-swatch" data-key="${esc(b.key)}" value="${b.cur}" aria-label="Gradient stop at ${b.pct} percent"><span class="swatch-cue" aria-hidden="true"></span></label><span class="stop-pct">${b.pct}%</span><label class="color-field hex">Hex<input type="text" data-fmt="hex" value="${shortHex(b.cur)}" spellcheck="false" aria-label="Hex for the gradient stop at ${b.pct} percent"></label></div>`).join("");
    html += `<div class="color-row gradient" data-grad="${esc(g.id)}">
      <div class="gradient-head"><span class="gradient-title">${g.type === "radial" ? "Radial" : "Linear"} gradient</span><div class="gradient-bar" style="background:linear-gradient(90deg, ${bar})"></div></div>
      <div class="gradient-stops">${stopsHtml}</div>
    </div>`;
  }

  colorEditor.innerHTML = html;
}

function rowForKey(key) { return [...colorEditor.querySelectorAll(".color-row")].find((r) => r.dataset.key === key); }
function swatchForKey(key) { return [...colorEditor.querySelectorAll(".color-swatch")].find((s) => s.dataset.key === key); }

function syncColorFields(key, hex, source) {
  const rgb = hexToRgb(hex), hsl = rgbToHsl(rgb.r, rgb.g, rgb.b), cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b);
  const vals = { hex: shortHex(hex), rgb: `${rgb.r}, ${rgb.g}, ${rgb.b}`, hsl: `${hsl.h}, ${hsl.s}%, ${hsl.l}%`, cmyk: `${cmyk.c}, ${cmyk.m}, ${cmyk.y}, ${cmyk.k}` };
  const row = rowForKey(key);
  if (row) {
    const sw = row.querySelector(".color-swatch");
    if (sw && sw !== source) sw.value = hex;
    row.querySelectorAll("[data-fmt]").forEach((f) => { if (f !== source) f.value = vals[f.dataset.fmt]; });
    return;
  }
  const sw = swatchForKey(key); // gradient stop
  if (sw) {
    if (sw !== source) sw.value = hex;
    const stopField = sw.closest(".gradient-stop")?.querySelector('[data-fmt="hex"]');
    if (stopField && stopField !== source) stopField.value = shortHex(hex);
    const grad = sw.closest(".color-row.gradient");
    if (grad) {
      const bar = grad.querySelector(".gradient-bar");
      const stops = [...grad.querySelectorAll(".gradient-stop")].map((st) => {
        const s = st.querySelector(".color-swatch");
        const pct = (st.textContent.match(/\d+/) || [0])[0];
        return `${s.value} ${pct}%`;
      });
      if (bar) bar.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
    }
  }
}

function updateColor(key, hex, source) {
  if (!key || !hex) return;
  // Re-attach the original paint's alpha: the picker only speaks opaque.
  const holder = source.closest("[data-alpha]") || swatchForKey(key)?.closest("[data-alpha]");
  const alpha = holder ? holder.dataset.alpha : "";
  recolor[key] = alpha ? colorToHex(hex) + alpha : shortHex(hex);
  syncColorFields(key, hex, source);
  const resetBtn = $("color-reset");
  if (resetBtn) resetBtn.disabled = Object.keys(recolor).length === 0;
  scheduleColorRender();
}

colorEditor.addEventListener("input", (e) => {
  const el = e.target;
  if (el.classList.contains("color-swatch")) updateColor(el.dataset.key, el.value, el);
  else if (el.dataset && el.dataset.fmt) {
    // The nearest keyed ancestor: a solid color row, or a single gradient stop.
    const key = el.closest("[data-key]")?.dataset.key;
    const hex = parseFormat(el.dataset.fmt, el.value);
    if (key && hex) updateColor(key, hex, el);
  }
});
colorEditor.addEventListener("click", (e) => {
  if (e.target.id === "color-reset") {
    recolor = {};
    buildColorEditor(listPaints(base));
    applyColorsAndRender();
  }
});

// -------- sponsor button magic (sparkle rim + floating hearts) --------
// The tooltip bubble itself is pure CSS; this builds the sparkle layer sized
// to the bubble's real box and streams hearts while a mouse hovers. Reduced
// motion skips all of it, touch never sees it, keyboard focus gets sparkles.
const sponsorBtn = document.querySelector(".sponsor-btn");
if (sponsorBtn && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const HEART_PATH = "M12 21s-6.7-4.35-9.33-8.11C.8 10.2 1.96 6.5 5.14 5.44c1.9-.63 3.98.03 5.36 1.6L12 8.6l1.5-1.56c1.38-1.57 3.46-2.23 5.36-1.6 3.18 1.06 4.34 4.76 2.47 7.45C18.7 16.65 12 21 12 21z";
  const SPARKS = ["✦", "✧", "⋆"];
  const SPARK_TINTS = ["", "var(--spk-b)", "var(--spk-c)"];
  let fx = null, heartTimer = 0, liveHearts = 0;
  const buildFx = () => {
    if (fx) return;
    const tip = getComputedStyle(sponsorBtn, "::after");
    // computed width/height are the content box; the visible bubble adds
    // padding and the gradient keyline, so include them or the stars hug a
    // box smaller than what the eye sees
    const pad = (p) => parseFloat(tip[p]) || 0;
    const w = (parseFloat(tip.width) || 122) + pad("paddingLeft") + pad("paddingRight") + 2;
    const h = (parseFloat(tip.height) || 18) + pad("paddingTop") + pad("paddingBottom") + 2;
    fx = document.createElement("span");
    fx.className = "sponsor-fx";
    fx.setAttribute("aria-hidden", "true");
    fx.style.width = w + "px";
    fx.style.height = h + "px";
    // eight stars parked around the bubble's rim, each on its own phase
    const spots = [[-38, 4], [-30, 34], [-42, 68], [10, 102], [62, 96], [108, 74], [116, 30], [96, -5]];
    spots.forEach(([top, left], k) => {
      const s = document.createElement("span");
      s.className = "spk";
      s.textContent = SPARKS[k % SPARKS.length];
      s.style.top = top + "%";
      s.style.left = left + "%";
      s.style.fontSize = (9 + ((k * 5) % 6)) + "px";
      s.style.animationDelay = (-k * 0.21).toFixed(2) + "s";
      s.style.animationDuration = (1.5 + (k % 3) * 0.35).toFixed(2) + "s";
      if (SPARK_TINTS[k % 3]) s.style.color = SPARK_TINTS[k % 3];
      fx.appendChild(s);
    });
    sponsorBtn.appendChild(fx);
  };
  const spawnHeart = () => {
    if (liveHearts >= 7 || document.hidden) return;
    liveHearts++;
    const el = document.createElement("span");
    el.className = "sponsor-heart";
    el.setAttribute("aria-hidden", "true");
    el.style.setProperty("--hx", (Math.random() * 44 - 22).toFixed(0) + "px");
    el.style.setProperty("--hd", (1.05 + Math.random() * 0.7).toFixed(2) + "s");
    el.style.setProperty("--hs", (0.7 + Math.random() * 0.7).toFixed(2));
    el.style.setProperty("--hr", (Math.random() * 40 - 20).toFixed(0) + "deg");
    if (Math.random() < 0.33) el.style.color = "#ff9ed2";
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}"/></svg>`;
    el.addEventListener("animationend", () => { el.remove(); liveHearts--; });
    sponsorBtn.appendChild(el);
  };
  sponsorBtn.addEventListener("pointerenter", (e) => {
    buildFx();
    if (e.pointerType === "mouse") {
      spawnHeart();
      clearInterval(heartTimer);
      heartTimer = setInterval(spawnHeart, 300);
    }
  });
  sponsorBtn.addEventListener("pointerleave", () => { clearInterval(heartTimer); heartTimer = 0; });
  sponsorBtn.addEventListener("focus", buildFx);
}

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

// Highlight the section link for wherever the reader is. A line below the
// sticky header decides the active section so menu jumps and scrolling agree.
const navAnchors = [...document.querySelectorAll(".nav-links a")];
const navSections = navAnchors.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
navSections.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
// Short trailing sections pile into the final screen, where the page can no
// longer scroll each heading up to the line, so position alone cannot tell them
// apart at the bottom. Remember the clicked link and honor it while parked at
// the bottom; a real scroll (wheel or touch) clears it and the line takes over.
let clickedHash = null;
for (const a of navAnchors) if (a.hash) a.addEventListener("click", () => { clickedHash = a.hash; });
addEventListener("wheel", () => { clickedHash = null; }, { passive: true });
addEventListener("touchmove", () => { clickedHash = null; }, { passive: true });
function syncActiveLink() {
  const line = (siteNav ? siteNav.offsetHeight : 0) + 40;
  let current = null;
  for (const sec of navSections) {
    if (sec.getBoundingClientRect().top <= line) current = sec;
  }
  // At the very bottom the last section is current even when the page is too
  // short to lift its heading up to the line, unless the reader clicked one of
  // the piled-up trailing links, in which case honor that.
  if (navSections.length && Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2) {
    current = (clickedHash && navSections.find((s) => "#" + s.id === clickedHash)) || navSections[navSections.length - 1];
  }
  for (const a of navAnchors) {
    const on = !!current && a.hash === "#" + current.id;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}
let spyRaf = 0;
addEventListener("scroll", () => { if (!spyRaf) spyRaf = requestAnimationFrame(() => { spyRaf = 0; syncActiveLink(); }); }, { passive: true });
addEventListener("resize", syncActiveLink, { passive: true });
syncActiveLink();

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
