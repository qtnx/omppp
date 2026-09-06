# Changelog

## [Unreleased]

## [1.7.14] - 2026-09-06

### Added

- Added `ompx annotate install`, which writes the extension bundled inside the ompx binary to `~/.omp/annotate/extension` (or `--dir`) and prints the Chrome load-unpacked steps.
- Added Cmd+. (macOS) / Ctrl+. toggle for the annotation overlay; also works in-page once the annotator has been opened in a tab.

### Changed

- Markers and the comment now stay on screen after a successful send; use Clear to start over.
- Screenshots are captured as the bare page and the numbered markers are drawn onto the image, so they stay aligned under DevTools device emulation and high-DPI displays.
- On touch or narrow (mobile) viewports the overlay opens in Pick mode so a single tap marks an element.

## [1.5.3] - 2026-07-07

### Added

- Added the initial OMPx Annotate Chrome extension package.
- Added the Alt+Shift+A annotation overlay toggle command.
- Added per-tab pairing codes with in-overlay pairing prompts for unpaired tabs.
- Added post-send keep-alive behavior that clears submitted state without closing the overlay.
- Added global host memory with stale per-tab code cleanup when the host changes.
