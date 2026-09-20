# phops – on-device video compressor

**→ [phops.catjam.dev](https://phops.catjam.dev)**

Shrink a video to an exact size (20 MB for Discord, 16 MB for WhatsApp, …) right on your phone.
The video is processed by your phone's own encoder through the browser's WebCodecs API –
**nothing is uploaded**, there are no accounts, no analytics, and it works offline once installed.

## Install it on your phone

1. Open **https://phops.catjam.dev** on the phone.
2. Add it to the home screen:
   - **Android** (Chrome / Edge / Samsung Internet): menu **⋮ → Install app** (or *Add to Home screen*), or tap the **Install app** button at the bottom of the page.
   - **iPhone / iPad** (Safari, iOS 17+): **Share → Add to Home Screen**.
3. That's it. After the first load everything is cached, so it opens and compresses even in airplane mode.
   Updates are picked up automatically the next time you open it while online.

On Android you can also send a video straight to it: in your gallery tap **Share → phops**.

## Features
- **Compress by:** target size (MB, with presets), percent of original, quality preset, CRF (constant quality), or manual bitrate
- **Never exceed** option: re-encodes (up to 3 passes) if the encoder overshoots the target size
- **Codecs:** H.264, H.265/HEVC, VP9, AV1, VP8 (whatever the device supports) · **Formats:** MP4, MOV, WebM, MKV
- Resolution / frame rate (Auto picks a sensible one for the bitrate), audio bitrate / mono / keep / remove
- Trim, rotate, VBR/CBR, hardware vs software encoder, keyframe interval
- Save or Share the result

Tip: keep the screen on while it compresses – phones pause encoding in the background.

## Hosting it yourself

The app is plain static files with no build step and no external requests. Browsers only allow video
encoding and installation from an **https://** address (or `localhost`), so pick one of:

### Any static host (Cloudflare Pages, GitHub Pages, Netlify, …)
```
node make-dist.mjs                                        # copies the public files into dist/
npx wrangler pages deploy dist --project-name phops       # Cloudflare Pages example
```
Only upload `dist/` – it deliberately leaves out `local-https/`.

### Local HTTPS from your PC (no online host)
```
node local-https/serve.mjs
```
On the phone (same Wi-Fi) open the `http://…:8080` address it prints, install and trust the certificate once,
then follow the link to the app. The script creates its own certificate authority in `local-https/cert/`,
restricted to private-network addresses. Keep that folder private and never upload it. To undo, remove
"phops local CA" from the phone's certificates. Requires `openssl` (ships with Git for Windows).

### Quick test on a PC
`npx http-server -p 8765 -c-1 .` → http://localhost:8765

## Third-party
`vendor/` contains [Mediabunny](https://mediabunny.dev) and its AAC encoder extension (MPL-2.0), unmodified.
