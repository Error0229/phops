// Serves phops over HTTPS on your home network so a phone can install it – no online host needed.
//
//   node local-https/serve.mjs
//
// First run creates a private certificate authority (CA) in local-https/cert/. The phone has to trust
// that CA once (instructions are printed, and shown at the http:// address). The CA is restricted to
// private-network addresses, so it cannot be used to impersonate real websites – still, keep
// local-https/cert/ca.key to yourself and never upload the cert folder anywhere.

import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSocket } from 'node:dgram';

const HTTPS_PORT = +process.env.PORT || 8443;
const HTTP_PORT = +process.env.HTTP_PORT || 8080;
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const certDir = join(here, 'cert');
const P = (f) => join(certDir, f);

/* ---------- addresses ---------- */

const ips = Object.values(networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
const host = hostname().toLowerCase();
const dnsNames = ['localhost', host, `${host}.local`];
const PRIVATE = [['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'], ['169.254.0.0', '255.255.0.0'], ['127.0.0.0', '255.0.0.0']];
const toInt = (ip) => ip.split('.').reduce((a, b) => (a << 8 | +b) >>> 0, 0);
const isPrivate = (ip) => PRIVATE.some(([net, mask]) => ((toInt(ip) & toInt(mask)) >>> 0) === toInt(net));
// PCs often have many virtual adapters (WSL, VMware, VPNs). Put the address of the adapter that actually
// routes to the network first – a UDP "connect" reveals it without sending any packet.
const routed = await new Promise((resolve) => {
  const s = createSocket('udp4');
  s.on('error', () => resolve(null));
  s.connect(53, '192.0.2.1', () => { const a = s.address().address; s.close(); resolve(a); });
});
const usableIps = ips.filter(isPrivate).sort((a, b) => (b === routed) - (a === routed));

/* ---------- certificates ---------- */

function findOpenssl() {
  const candidates = ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch {}
  }
  console.error('openssl was not found. Install Git for Windows (it ships openssl) or add openssl to PATH.');
  process.exit(1);
}

function ensureCerts() {
  mkdirSync(certDir, { recursive: true });
  let openssl;
  const run = (args) => {
    try { execFileSync(openssl ??= findOpenssl(), args, { stdio: 'pipe' }); }
    catch (e) { console.error(String(e.stderr || e)); process.exit(1); }
  };

  if (!existsSync(P('ca.crt')) || !existsSync(P('ca.key'))) {
    const permitted = [
      ...PRIVATE.map(([n, m]) => `permitted;IP:${n}/${m}`),
      ...dnsNames.map((d) => `permitted;DNS:${d}`),
    ].join(',');
    writeFileSync(P('ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
      '[dn]', `CN=phops local CA (${host})`, 'O=phops',
      '[v3]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash', `nameConstraints=critical,${permitted}`, '',
    ].join('\n'));
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-keyout', P('ca.key'), '-out', P('ca.crt'), '-config', P('ca.cnf')]);
    console.log('Created a new local certificate authority in local-https/cert/.');
  }

  const sans = [...usableIps.map((i) => `IP:${i}`), 'IP:127.0.0.1', ...dnsNames.map((d) => `DNS:${d}`)].join(',');
  const stale = !existsSync(P('server.crt')) || !existsSync(P('server.key'))
    || !existsSync(P('sans.txt')) || readFileSync(P('sans.txt'), 'utf8') !== sans
    || Date.now() - statSync(P('server.crt')).mtimeMs > 300 * 864e5;
  if (stale) {
    writeFileSync(P('server.cnf'), [
      'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth', `subjectAltName=${sans}`, '',
    ].join('\n'));
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', P('server.key'), '-out', P('server.csr'), '-subj', '/CN=phops']);
    run(['x509', '-req', '-sha256', '-days', '365', '-in', P('server.csr'), '-CA', P('ca.crt'), '-CAkey', P('ca.key'),
      '-CAcreateserial', '-out', P('server.crt'), '-extfile', P('server.cnf')]);
    writeFileSync(P('sans.txt'), sans);
  }
}

/* ---------- static files ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'https://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  const rel = file.slice(root.length + 1);
  const hidden = !file.startsWith(root + sep) || rel.split(sep).some((p) => p.startsWith('.')) || rel.startsWith('local-https');
  if (hidden || !TYPES[extname(file)] || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
}

/* ---------- go ---------- */

ensureCerts();
const appUrls = usableIps.map((ip) => `https://${ip}:${HTTPS_PORT}/`);
const primary = appUrls[0] || `https://localhost:${HTTPS_PORT}/`;

createHttps({ key: readFileSync(P('server.key')), cert: readFileSync(P('server.crt')) }, serveStatic)
  .listen(HTTPS_PORT, '0.0.0.0');

// Plain-http helper: only hands out the (public) CA certificate and setup steps. It never serves the app.
createHttp((req, res) => {
  if (req.url.startsWith('/phops-ca.crt')) {
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="phops-ca.crt"' });
    res.end(readFileSync(P('ca.crt')));
    return;
  }
  const appUrl = `https://${(req.headers.host || '').split(':')[0] || 'localhost'}:${HTTPS_PORT}/`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>phops setup</title>
<body style="font:17px/1.5 system-ui;max-width:34em;margin:2em auto;padding:0 1em;background:#0f1115;color:#f1f2f4">
<h2>phops – one-time phone setup</h2>
<p><a style="color:#ff6a3d;font-weight:700" href="/phops-ca.crt">1. Download the certificate</a></p>
<p><b>2. Trust it</b></p>
<p><u>Android</u>: Settings → search “CA certificate” → <i>Install a certificate → CA certificate</i> → Install anyway → pick <code>phops-ca.crt</code>.</p>
<p><u>iPhone</u>: allow the profile download (use Safari) → Settings → <i>Profile Downloaded</i> → Install. Then Settings → General → About → <i>Certificate Trust Settings</i> → switch on “phops local CA”.</p>
<p><b>3. Open the app</b>: <a style="color:#ff6a3d" href="${appUrl}">${appUrl}</a> and add it to your home screen (Android: Chrome menu → Install app · iPhone: Share → Add to Home Screen).</p>
<p style="color:#9aa1ae;font-size:14px">After that the app works offline – the PC only needs to be on when you want to pick up an updated version.</p>`);
}).listen(HTTP_PORT, '0.0.0.0');

const setupUrl = `http://${usableIps[0] || 'localhost'}:${HTTP_PORT}/`;
console.log(`
phops is being served on your network.

  On the phone (same Wi-Fi), first time only:   ${setupUrl}
     -> download + trust the certificate, then follow the link to the app

  App:  ${primary}${appUrls.length > 1 ? `
        (other adapters: ${appUrls.slice(1).join('  ')})` : ''}
  PC :  https://localhost:${HTTPS_PORT}/  (browser will warn here unless the PC trusts the CA too – not needed)

If the phone cannot connect, allow "Node.js" through Windows Firewall for Private networks.
${ips.length > usableIps.length ? `Skipped non-private addresses: ${ips.filter((i) => !isPrivate(i)).join(', ')}\n` : ''}Press Ctrl+C to stop.`);
