# phops – on-device video compressor (PWA)

Compresses videos entirely on the phone using the browser's WebCodecs API (the phone's own
hardware/software encoders). No uploads, no analytics, no CDN – every file the app needs is in this folder.

## Features
- **Compress by:** target size (MB, with presets), percent of original, quality preset, CRF (constant quality), or manual bitrate
- **Never exceed** option: re-encodes (up to 3 passes) if the encoder overshoots the target size
- **Codecs:** H.264, H.265/HEVC, VP9, AV1, VP8 (whatever the device supports) · **Formats:** MP4, MOV, WebM, MKV
- Resolution / frame-rate (auto picks a sensible one for the bitrate), audio bitrate / mono / keep / remove
- Trim, rotate, VBR/CBR, hardware vs software encoder, keyframe interval
- Save or Share the result; on Android you can also *share a video to phops* from the gallery
- Works offline once installed

## Putting it on your phone
Browsers only allow video encoding + installation from an **https://** address, so the folder has to be
served from some static host once (the host only ever serves these files; your videos never go anywhere):

- **Local HTTPS from this PC (no online host):** run `node local-https/serve.mjs`, then on the phone (same Wi-Fi)
  open the `http://…:8080` address it prints, install + trust the certificate once, and follow the link to the app.
  The script makes its own certificate authority in `local-https/cert/` (limited to private-network addresses).
  Keep that folder private and do not upload it. To undo, remove "phops local CA" from the phone's certificates.
- Or any static host: GitHub Pages, Cloudflare Pages, Netlify (drag-and-drop the folder, minus `local-https/`).

Then open the URL on the phone:
- **Android (Chrome/Edge/Samsung):** menu → *Install app* / *Add to Home screen* (or the "Install app" button in the footer)
- **iPhone (Safari, iOS 17+):** Share → *Add to Home Screen*

After the first load everything is cached; it runs with airplane mode on.

## Local testing on a PC
`npx http-server -p 8765 -c-1 .` → http://localhost:8765 (localhost counts as secure).

## Third-party
`vendor/` contains [Mediabunny](https://mediabunny.dev) and its AAC encoder extension (MPL-2.0), unmodified.
