# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.4.4] - 2026-07-20

### Changed

- The sponsor tooltip wears a bolder frame: a four-pixel gold-to-lavender-to-pink keyline the arrow melts into, replacing the hairline border.

## [1.4.3] - 2026-07-19

### Fixed

- The sponsor tooltip keyline now flows around the arrow, up one edge, over the tip, and down the other, with no line across the base and no gaps at the shoulders.

## [1.4.2] - 2026-07-19

### Fixed

- The sponsor tooltip keyline now runs unbroken across the arrow base: the arrow tucks behind the bubble and its outlined tip grows out of the border instead of interrupting it.

## [1.4.1] - 2026-07-19

### Fixed

- The sponsor tooltip arrow now grows out of the bubble as one shape, its keyline flowing up into the point, instead of sitting on it as a separate triangle.

## [1.4.0] - 2026-07-19

### Added

- The sponsor tooltip turned magical: a charmed bubble with a pink-to-gold keyline that springs open and breathes a soft glow, sparkles twinkling around its rim, and little hearts tumbling out of the button while it is hovered. Keyboard focus gets the bubble and sparkles, touch stays plain, and reduced motion gets a calm fade.

## [1.3.0] - 2026-07-19

### Added

- Gradient stops now take a typed HEX value beside the wheel, and recoloring a translucent paint keeps its transparency instead of silently turning it solid.
- Malformed path data now says so: a notice explains the path was cut at the first invalid command, exactly where a browser stops drawing it.
- Dropping selected text onto the box now loads it, alongside the existing .svg file drop.

### Changed

- The Custom preview background applies the moment the chip is tapped, and the chip wears the same key styling as its neighbors.
- The paste button always answers: it fills the box, says the clipboard is empty, or spells out how to paste manually.
- Screen readers now hear result notices and the wipe position as sentences; heading emoji stay visual only; the wipe handle focus ring reads on any backdrop; text-field focus is a clear accent outline in both themes.
- Pages load network-first so a new release reaches the next visit, and an offline deep link shows the not-found page instead of silently opening the app.
- The inline script is authorized by hash instead of a blanket allowance, closing the door a future escaping slip would otherwise open.
- The hero mockup shows the bundled sample's real numbers.

### Fixed

- A rejected file drop no longer wipes the preview and stats of a still-valid result, and a failed file read shows its message on a fresh page.
- An optimize error now hides the whole result area instead of leaving orphaned headings and dead buttons around the message.

## [1.2.0] - 2026-07-19

### Added

- The engine re-encodes path data into its shortest exact spelling: each segment picks absolute or relative form, flat lines become H and V, mirrored curves become S and T, and repeated commands share one letter. Same drawing, meaningfully fewer bytes.
- Identity transforms are dropped, and a matrix that is really a translation or a scale is rewritten to the shorter named form.
- Style attributes fold into presentation attributes once no stylesheet remains, xlink:href becomes the modern href, and a bare defs holding only gradients and friends unwraps.
- The Try a sample file is now a faithful Illustrator legacy export, metadata block and all, so the before and after shows what a real export sheds: about 62 percent.

### Fixed

- A stray number after z in path data froze the page; it now truncates the way a renderer does.
- Parsing is linear in file size; a few-hundred-KB file used to exhaust memory and now optimizes in milliseconds.
- An arc radius could round down to zero, silently flattening the arc into a straight line.
- Malformed numbers like 1e309 or a bare exponent corrupted the output; they now truncate cleanly.
- Hostile inputs (thousand-deep nesting, enormous attributes) can no longer hang or crash the optimizer.

## [1.1.9] - 2026-07-19

### Changed

- The Try a sample icon is now a rounded verified badge, replacing the shield whose bottom point was clipped.

## [1.1.8] - 2026-07-19

### Changed

- The output actions now sit on their own row above the code, right-aligned, instead of floating over it.

## [1.1.7] - 2026-07-19

### Changed

- The before/after slider and the swatch edit badges now use the bright brand chartreuse in the light theme too, instead of the darker green, so they stay vivid and the dark icons on them stay legible.

## [1.1.6] - 2026-07-19

### Changed

- Disabled buttons now press down onto their base like the other keys, so the locked state looks pressed in instead of floating flat.

## [1.1.5] - 2026-07-19

### Changed

- The selected preview background button now presses down to sit level with the buttons beside it, so the locked state reads as a natural key press.

## [1.1.4] - 2026-07-19

### Fixed

- Navigation links now stay highlighted when you jump to a section near the bottom of the page, such as the FAQ.

## [1.1.3] - 2026-07-19

### Fixed

- The section link for wherever you are on the page now highlights as you scroll, matching the rest of the navigation across the site.

## [1.1.2] - 2026-07-19

### Changed

- The selected preview background is locked: it takes a pressed, dashed, not-allowed state and cannot be clicked again, while the other options stay live.

## [1.1.1] - 2026-07-19

### Added

- A preview background chooser: the transparency checkerboard, white, black, or a color of your choice, so a graphic can be checked on the background it will sit on.

### Changed

- The before and after divider is thicker, with a dark keyline and a shadow, so it stands out over both the light and the dark checker tiles.
- Color swatches are rounded and carry a small pencil badge, so it is clear they open a color picker.

### Fixed

- The story section illustration is sized and positioned to match the rest of the page.

## [1.1.0] - 2026-07-18

### Added

- A color editor. Recolor any solid fill or gradient stop, with a wheel and HEX, RGB, HSL, and CMYK inputs that stay in sync. Changes travel into the SVG you copy or download.
- The JaydenART logo as a second sample: a real Illustrator export with ten linked gradients.

### Changed

- The before and after preview now reads left to right, with the original on the left, and the divider on the image drags directly, so the separate slider underneath is gone.

## [1.0.0] - 2026-07-18

First release.

### Added

- A browser tool that strips the bloat out of pasted SVG: the XML prolog and
  DOCTYPE, editor comments and metadata, Illustrator and Inkscape namespaces,
  default attributes, and over-precise coordinates, while keeping gradients,
  clip paths, masks, markers, referenced ids, and animation intact.
- A before and after preview with a wipe slider, so you can see the picture is
  unchanged, alongside the byte and gzipped size saved.
- A hand-written, dependency-free optimizer that runs the same in the browser
  and in Node, with a test suite covering real Illustrator, Inkscape, Figma,
  and Sketch exports plus animation, text, and hostile inputs.
- Removal of `<script>` elements, inline event handlers, and `javascript:`
  links, so a graphic you paste in cannot carry code out.
