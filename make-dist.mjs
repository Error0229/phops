// Copies only the app's public files into dist/ for uploading to a static host (Cloudflare Pages etc.).
// local-https/ (which holds a private CA key) is deliberately left out.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
const FILES = ['index.html', 'app.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'icons', 'vendor'];
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const f of FILES) cpSync(f, `dist/${f}`, { recursive: true });
console.log('dist/ is ready:', FILES.join(', '));
