# UW Color

Fixes the colour of underwater photos and GoPro video, directly on your phone or computer. It brings back the reds the water absorbed and removes the blue-green haze. Nothing is uploaded, and it works offline once installed.

**App:** https://manubolgia.github.io/Color-correct/ · **Sister app, UW Reels:** https://manubolgia.github.io/Color-correct/reels/

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

## UW Reels

Turns a clip into a 1080×1920 Instagram Reel. You choose how the 9:16 frame moves, so you stay in shot.

- **Drag the frame** at any moment to set a keyframe. Tap to put the frame's centre where you tap, and pinch (or use *ZOOM*) to zoom in. Between keyframes the frame moves *SMOOTH* (eases in and out, never overshoots), *LINEAR*, or *JUMP* (holds, then cuts).
- **Record a move:** drag while the clip plays and the frame follows your finger. The move is smoothed and turned into a few editable keyframes. *½×* or *¼×* speed makes it easier.
- **FOLLOW ME:** tap the button, then tap yourself in the picture. The app tracks that spot through the clip, both before and after the tap, and the frame follows you smoothly. Drag at any moment to correct it.
- **9:16 VIEW** previews the reel itself. **Trim** with the brackets above the timeline. Every frame comes from the original, and frame rate follows the source up to 60 fps (Instagram's limit), or 30 fps. Audio is copied unchanged.
- Your moves are remembered per clip. Export saves through the share sheet, straight to Instagram or to Photos.

It's a separate installable app (its own icon, works offline), built on the same video engine as UW Color. To fix colour as well, export from UW Color first and cut the corrected clip here.

## Install

Each app installs on its own: open its link and add it.

| Device | How |
| --- | --- |
| iPhone / iPad | Open the link in Safari → Share → **Add to Home Screen** |
| Android | Chrome → **Install** in the top bar (or menu → Install app). Once installed, UW Color appears in the share sheet of Gallery / GoPro Quik |
| Mac / Windows / Linux | Chrome or Edge → **INSTALL** in the top bar (or the install icon in the address bar). Once installed, you can open .jpg/.mp4 files with it from your file manager |

## Notes

- Video export needs WebCodecs: current Safari, Chrome, Edge or Firefox. If the browser's WebCodecs decoder refuses a clip (Safari does this for some H.264/HEVC files it can play fine), the app first retries with a cleaned-up decoder setup, then falls back to the browser's own video player and takes each frame from it. Export through that fallback can be slower, but every frame still matches the source exactly. HEVC (H.265) clips need a browser and device that can play HEVC: Safari, or Chrome/Edge with hardware support.
- Everything works offline once the app is installed. If the picker adds nothing while you're offline, the photos or videos are probably kept only in iCloud / Google Photos and have to download to the phone first, which needs a connection.
- Keep the screen on while a video exports. The app asks the device not to sleep, but switching apps can pause the export.
- **iPhone: add videos with *Choose Files*, not *Photo Library*.** iOS re-encodes every video picked from the Photo Library before any web app gets it (the “Preparing…” step), and that can cut the frame rate or size: an 8:7 4K60 GoPro clip arrives at 15 fps. To keep the original, save the clip to Files first (Photos → Share → Save to Files). The app flags clips that look re-encoded.
- Exports wait in the browser's private storage until you save them, so long 4K clips don't have to fit in memory. That storage is cleared the next time the app starts.

## How it works

All processing happens in the page:

- **Photos.** The image is read in horizontal strips. Each strip is colour-corrected and JPEG-encoded by a pool of Web Workers (`app/js/jpeg.js`). Restart markers make the strips independent, so they're encoded in parallel and simply concatenated. Because of this, no canvas ever has to hold the whole photo, which gets around iOS's ~16.7 MP canvas limit.
- **Video.** Both apps share one engine, `app/js/media.js`. It decodes and encodes with WebCodecs through [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, vendored in `app/vendor/`). If the decoder refuses a clip, it falls back to a patched decoder config, then to the browser's `<video>` player, taking one exact seek per frame. Every frame passes through a drawing step: UW Color's correction runs as a WebGL2 shader (`app/js/video.js`, `app/js/gl.js`), and UW Reels' moving crop is in `app/reels/js/path.js`. Encoding is paced so the encoder can't skip frames. The MP4 is streamed to disk (the origin-private file system) as it's written.
- **Follow me** (`app/reels/js/track.js`) reads small grey copies of the clip, about 10 a second. It follows the tapped patch with normalised cross-correlation, searching coarse then fine. The patch adapts slowly, keeps a little of the original so it doesn't drift, and is searched for across the whole frame when lost.
- **Colour science** lives in `app/js/color.js`, which the photo path, the video shader and the LUT export share.

## Development

The apps are plain static files in `app/` (UW Reels in `app/reels/`), with no build step:

```sh
npx http-server app -p 8080 -c-1     # then open http://localhost:8080 and http://localhost:8080/reels/
```

When you add a file, also add it to `ASSETS` in the service worker of each app that uses it: `app/sw.js`, and `app/reels/sw.js` for Reels and the shared files it imports. Deploys fail if one is missing (`node tools/check-assets.mjs`).

To update the vendored Mediabunny bundle: `cd tools && npm install && npm run vendor`.

Every push to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`). The service worker's cache name is stamped with the commit, so installed apps pick up a new version on their own (or show **UPDATE** when files are open). The version shown in the top bar is `VERSION` in `app/js/app.js` (and `app/reels/js/reels.js`); bump it with each release.
