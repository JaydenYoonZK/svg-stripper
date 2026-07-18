# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
