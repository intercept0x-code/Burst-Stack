# BurstStacker Web v2

A phone-first, GitHub Pages-ready computational photography app that combines a burst of near-duplicate photographs into a cleaner, brighter, more detailed result. Processing happens in the browser; the photos are not uploaded to a server by this app.

## v2 pipeline

1. **RAW / rendered decode** — JPEG, PNG and WebP use the browser decoder. DNG, CR2/CR3, NEF, ARW, RAF, RW2 and ORF use `libraw-wasm` with camera white balance and sRGB output.
2. **Reference selection** — measures Laplacian edge variance and automatically chooses the sharpest frame.
3. **Feature alignment** — ORB feature matching + RANSAC homography. A translation-template fallback handles feature-poor bursts.
4. **Shared-area crop** — removes borders introduced by alignment.
5. **Multi-frame reconstruction** — 2× mode maps native source pixels directly into a 2× reconstruction coordinate system before fusion; it does not stack at 1× and resize afterward.
6. **Per-pixel sharpness weighting** — locally sharper samples receive more influence.
7. **Exposure fusion** — well-exposed samples receive more weight, useful for slightly different burst exposures.
8. **Motion / ghost rejection** — non-reference pixels that locally disagree with the aligned reference are continuously down-weighted.
9. **Linear-light fusion** — RGB samples are averaged in linear light rather than directly averaging gamma-compressed sRGB values.
10. **Finish pass** — adjustable midtone brightness and conservative unsharp detail enhancement.

## Modes

- **Balanced** — the default.
- **Detail** — stronger sharpness weighting and gentler motion rejection.
- **Motion** — stronger ghost rejection for moving people / objects.
- **HDR** — much stronger exposure weighting with less aggressive global exposure normalization.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints.

## Put it on GitHub Pages

1. Create a GitHub repository.
2. Upload the contents of this folder to the repository root.
3. Make sure the default branch is named `main`.
4. In **Settings → Pages**, set **Source** to **GitHub Actions**.
5. Push a commit. `.github/workflows/pages.yml` installs the dependencies, builds the app and deploys `dist/` automatically.

`vite.config.js` uses `base: './'`, so the app works from a project Pages URL without hard-coding the repository name.

## Memory behavior

High-resolution burst reconstruction can consume a lot of browser RAM. **Adaptive full resolution** is enabled by default and chooses a conservative input size based on device memory / screen class, especially in 2× mode. You can disable it on a high-memory desktop if you want to attempt native-resolution processing.

## Technical notes

- OpenCV.js is loaded from the official OpenCV 4.x documentation build.
- RAW decoding is provided by `libraw-wasm` 1.6.0.
- All alignment/fusion is local. The only network requests are to load the application dependencies unless they are already cached.
- 2× reconstruction can recover useful sub-pixel sampling information when the burst contains small fractional camera shifts. It cannot recover scene information that was never captured, and large motion/focus changes still reduce stack quality.
