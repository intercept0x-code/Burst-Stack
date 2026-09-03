# BurstStacker Web v2.1 — Static GitHub Pages Build

This version is intentionally **build-free**. It can be served directly by GitHub Pages.

## Deploy

1. Put the contents of this folder at the root of your GitHub repository.
2. In GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select your main branch and **/(root)**.
5. Save and wait for GitHub Pages to publish.

Do **not** run Vite and do not point Pages at the old source build.

## Files that must be at repo root

- `index.html`
- `style.css`
- `app.js`
- `manifest.webmanifest`
- `icon.svg`
- `sw.js`
- `.nojekyll`

## Why v2 looked broken

The old source expected Vite to bundle `style.css` into JavaScript and resolve the npm `libraw-wasm` import. It also used `/app.js`, which points to the domain root rather than a GitHub project subdirectory. When the unbuilt source was published directly, the browser got the HTML but not the app bundle or styles.

v2.1 fixes that by:

- linking `./style.css` directly;
- loading `./app.js` with a project-relative URL;
- removing all required npm/Vite imports;
- lazy-loading the optional RAW decoder only when RAW files are selected;
- keeping standard JPEG/PNG/WebP processing independent of RAW loading;
- using only relative PWA/service-worker paths.

## Processing features

- sharpest-frame reference selection
- ORB/RANSAC multi-frame alignment
- translation fallback
- common-overlap cropping
- local motion / ghost suppression
- per-pixel sharpness weighting
- exposure weighting
- linear-light fusion
- 1× stacking or 2× sub-pixel reconstruction
- final brightness/detail pass
- before/after comparison
- PNG export
- experimental browser-side RAW decoding for DNG/CR2/CR3/NEF/ARW/RAF/RW2/ORF

RAW decoding requires the browser to reach the external `libraw-wasm` module CDN. Normal rendered images do not.
