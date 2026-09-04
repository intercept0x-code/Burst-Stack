# BurstStacker Web v3.0 — Static GitHub Pages Build

BurstStacker is a build-free, phone-first burst-photo stacking app. All standard-image processing happens in the browser; RAW decoding is lazy-loaded only when a RAW file is selected.

## Deploy on GitHub Pages

1. Replace the old repository contents with the contents of this folder.
2. GitHub → **Settings → Pages**.
3. Choose **Deploy from a branch**.
4. Choose `main` and `/(root)`.
5. Save.

No npm, Vite, build step, or GitHub Action is required.

## v3.0 highlights

### Mobile/UI
- redesigned phone-first workflow
- sticky mobile action dock
- compact burst preview after selection instead of an empty hero panel
- horizontal frame tray with tap-to-pin reference
- result view modes: Compare / Stacked / Reference
- bottom-sheet export UI
- native mobile Share support when available
- installable PWA prompt
- live burst preflight and output-size estimate
- cancelable processing and screen wake lock during long stacks

### Computational photography
- composite reference scoring (sharpness + clipping + exposure)
- optional manual reference pinning
- ORB/RANSAC perspective alignment with transform sanity checks
- translation-only mode and translation fallback
- weak-alignment auto rejection
- full-reference edge mode (keeps composition; edges may use fewer frames)
- tight common-overlap crop mode
- linear-light weighted fusion
- local sharpness weighting
- exposure confidence weighting and clipping penalty
- color + luminance robust motion rejection
- reference anchoring for moving regions
- chunked fusion loops for better mobile responsiveness/cancellation
- adaptive memory sizing based on device memory, frame count and reconstruction scale
- 1× or 2× multi-frame reconstruction

### Finishing/export
- live preview-only finishing controls (brightness, shadows, highlights, contrast, color, warmth, detail)
- full-resolution finishing is applied only at export time to keep mobile editing responsive
- PNG, JPEG and WebP export
- JPEG/WebP quality control
- full-resolution native share sheet support where the browser permits file sharing

## External runtime dependencies

- OpenCV.js is loaded from `docs.opencv.org`.
- RAW files use `libraw-wasm` from `esm.sh` only when RAW input is selected.
- JPEG/PNG/WebP stacking does not depend on the RAW decoder.
