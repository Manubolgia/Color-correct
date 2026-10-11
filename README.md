# UW Color

Fixes the colour of underwater photos and GoPro video, directly on your phone or computer. It brings back the reds the water absorbed and removes the blue-green haze. Nothing is uploaded, and it works offline once installed.

**App:** https://manubolgia.github.io/Color-correct/

## What it does

- **Photos at full resolution.** Exports a JPEG the same size as the original (27 MP GoPro stills included, iPhone too). It keeps the camera's Exif data: date, camera, exposure and GPS. You can pick STD / HIGH / MAX quality (JPEG 90 / 95 / 100, no chroma subsampling).
- **Video up to 4K60.** Re-encodes the clip with the correction applied, at the same resolution and frame rate, and copies the audio unchanged. The output is H.264 or HEVC, matching the source when the device can encode it.
  - *Adaptive* (default): re-balances as depth and light change through the clip, easing between looks so it doesn't flicker.
  - *Lock to frame*: uses one frame's balance for the whole clip.
- **Tap neutral.** Tap sand, a tank or a white fin for an exact white balance. Tap again anywhere to move the point; dragging still compares before/after.
- **Batch.** *ALL* exports every photo and video in the strip. Drop the ones you don't want with the × on the current thumbnail, or *SELECT* → tap several → *DELETE* (with *UNDO*).
- **.cube LUT** of the current correction, for Premiere, Resolve, Final Cut or LumaFusion.
- **Easy saving.**
  - iPhone/Android: *SAVE / SHARE* opens the share sheet (choose “Save Image” / “Save Video” to put it in Photos).
  - Computer: *DOWNLOAD*, or *SAVE TO FOLDER…* to choose a folder once; later exports go straight there.

## Install

| Device | How |
| --- | --- |
| iPhone / iPad | Open the link in Safari → Share → **Add to Home Screen** |
| Android | Chrome → **Install** in the top bar (or menu → Install app). Once installed, UW Color appears in the share sheet of Gallery / GoPro Quik |
| Mac / Windows / Linux | Chrome or Edge → **INSTALL** in the top bar (or the install icon in the address bar). Once installed, you can open .jpg/.mp4 files with it from your file manager |

## Notes

- Video needs WebCodecs: current Safari, Chrome, Edge or Firefox. HEVC (H.265) clips need a browser and device that can decode HEVC: Safari, or Chrome/Edge with hardware support. On the GoPro, H.264 is the most compatible setting.
- Everything works offline once the app is installed. If the picker adds nothing while you're offline, the photos or videos are probably kept only in iCloud / Google Photos and have to download to the phone first, which needs a connection.
- Keep the screen on while a video exports. The app asks the device not to sleep, but switching apps can pause the export.
- On iPhone, picking a video from the Photos library can make iOS hand over a compressed copy. If the resolution shown is lower than what you filmed, pick the clip via **Files** instead.
- Exports wait in the browser's private storage until you save them, so long 4K clips don't have to fit in memory. That storage is cleared the next time the app starts.

## How it works

All processing happens in the page:

- **Photos.** The image is read in horizontal strips. Each strip is colour-corrected and JPEG-encoded by a pool of Web Workers (`app/js/jpeg.js`). Restart markers make the strips independent, so they're encoded in parallel and simply concatenated. Because of this, no canvas ever has to hold the whole photo, which gets around iOS's ~16.7 MP canvas limit.
- **Video.** Clips are decoded and encoded with WebCodecs through [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, vendored in `app/vendor/`). The correction runs as a WebGL2 shader (`app/js/gl.js`). The MP4 is streamed to disk (the origin-private file system) as it's written.
- **Colour science** lives in `app/js/color.js`, which the photo path, the video shader and the LUT export share.

## Development

The app is plain static files in `app/`, with no build step:

```sh
npx http-server app -p 8080 -c-1     # then open http://localhost:8080
```

When you add a file to `app/`, also add it to `ASSETS` in `app/sw.js` (deploys fail if it's missing: `node tools/check-assets.mjs`).

To update the vendored Mediabunny bundle: `cd tools && npm install && npm run vendor`.

Every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`). The service worker's cache name is stamped with the commit, so installed apps show an **UPDATE** button when a new version is live.
