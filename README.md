# SVG Stripper 💃

Paste a bloated SVG, get a clean one back. It strips out the parts an exporter
leaves behind that a browser never needed, keeps everything that draws a pixel,
and shows you the before and after side by side so you can see the picture did
not change.

**Live tool: [jaydenyoonzk.github.io/svg-stripper](https://jaydenyoonzk.github.io/svg-stripper/)**

It runs entirely in your browser. Your SVG is never uploaded, logged, or
stored, and it keeps working offline after the first visit.

## Why

An icon exported from Illustrator, Figma, Inkscape, or Sketch usually arrives
three or four times larger than it needs to be. The file carries the layer
names, the app version, the canvas zoom, a generator comment, a DOCTYPE from an
older web, and coordinates measured to six decimal places. None of it changes a
single pixel. SVG Stripper takes it off.

## What it strips

- The `<?xml?>` prolog and the `<!DOCTYPE>`
- Generator comments and `<metadata>` blocks
- Illustrator, Inkscape, and Sketch namespaces and their attributes
- Attributes already set to their default, like `fill-opacity="1"`
- Ids that nothing references, and empty or redundant groups
- Coordinates rounded past a precision you choose, and long hex colors
- `<script>` elements, inline `on…` handlers, and `javascript:` links

## What it keeps

- Every shape and its geometry, down to the chosen precision
- Gradients, patterns, filters, clip paths, and masks
- Any id that is referenced, and the reference that uses it
- `<title>` and `<desc>`, unless you turn them off
- Text and the whitespace inside it, exactly as written
- `fill-rule="evenodd"` and other non-default values
- Animation: `<animate>`, `<animateTransform>`, and motion paths

## Recolor

Once an SVG is loaded, the Colors panel lists every solid fill and every
gradient stop it found. Change any of them from the color picker or by typing a
HEX, RGB, HSL, or CMYK value, and the new colors go into the SVG you copy or
download. CMYK is a convenience that converts to RGB, since SVG on the web is an
RGB format, so the on-screen preview is the true result. Parts painted the same
color move together.

## How it works

The engine ([`docs/optimizer.js`](docs/optimizer.js)) is a small,
dependency-free module that runs the same in the browser and in Node. It parses
the SVG into a tree, runs a series of passes over it, and serializes it back,
minified or formatted. Three things get the most care, because they are where a
careless optimizer breaks a graphic:

- **References are resolved first.** Before anything is removed, every
  `url(#…)`, `href="#…"`, and animation timing reference is collected. An id
  that is used anywhere is kept, along with the element it belongs to. Nothing
  ends up pointing at a missing id.
- **Text is left alone.** Whitespace inside `<text>`, `<tspan>`, and
  `<textPath>` is preserved byte for byte, because collapsing it would move the
  rendered words.
- **Arc flags are parsed, not guessed.** In path data, the two flags of an arc
  command can be written with no separators (`a5 5 0 015 5`). The path parser
  reads them as flags, so rounding the numbers never merges a flag into a
  coordinate.

The preview renders your SVG inside an `<img>` element, which browsers load in
a restricted mode with no scripting and no external requests, so a hostile SVG
cannot run code or phone home through it.

## Scope

This is a focused tool, not a reimplementation of [SVGO](https://github.com/svg/svgo).
It handles the common job of cleaning up a design-tool export and shows you the
result. Path data is re-encoded to its shortest exact spelling (absolute or
relative per segment, `H`/`V` for axis lines, `S`/`T` for mirrored curves), but
it does not reshape geometry or merge shapes the way SVGO's heaviest passes
can, on purpose, because those are the passes most likely to change something
you did not expect.

## Develop

```bash
npm test          # run the optimizer and site test suites
npm run serve     # serve docs/ at http://localhost:8331
```

The test suite runs real Illustrator, Inkscape, Figma, and Sketch exports plus
animation, text, and hostile inputs through the engine, and checks that the
output never points at a missing id, is idempotent, and is never larger than
the input.

## License

MIT. Copyright © [Jayden Yoon ZK](https://www.JaydenYoonZK.com).
