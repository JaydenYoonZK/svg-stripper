# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
