#!/usr/bin/env node
/**
 * Serve `dist/` over HTTPS, for the tests that cannot run without it.
 *
 * Passkeys are the reason. `@wharfkit/webauthn` reads the origin out of the
 * credential's clientDataJSON and throws "WebAuthn keys require https" for
 * anything else — not a stylistic preference but the shape of an Antelope
 * `PUB_WA_` key, which carries the relying party id the chain then checks. A
 * key made over http is not a weaker key; it is not a key.
 *
 * So the passkey spec needs a real https origin, and `localhost` as the
 * hostname: a relying party id has to be a registrable domain and a bare IP
 * address is not one, which is why the rest of the suite's 127.0.0.1 will not
 * do.
 *
 * The certificate is generated here, into a temporary directory, every time.
 * A committed one would be a private key in the repository, and a long-lived
 * one is a thing that expires on a Sunday.
 *
 * Usage:
 *   node scripts/serveDistHttps.mjs [port]
 */

import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = Number(process.argv[2] || 4443);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

function selfSignedCert() {
    const dir = mkdtempSync(join(tmpdir(), 'polaris-https-'));
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');

    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert,
        '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });

    return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * Resolve a request path to a file inside dist, or null.
 *
 * Extensionless paths map to their .html file, which is how the production
 * nginx serves /submit — a test that reached a 404 where the deployment
 * serves a page would be testing the server rather than the app.
 */
function resolve(urlPath) {
    const clean = normalize(decodeURIComponent(urlPath.split('?')[0]))
        .replace(/^(\.\.[/\\])+/, '');
    const candidates = clean === '/' || clean === ''
        ? ['index.html']
        : [clean.replace(/^\//, ''), `${clean.replace(/^\//, '')}.html`];

    for (const candidate of candidates) {
        const full = join(ROOT, candidate);
        if (!full.startsWith(ROOT)) continue;
        if (existsSync(full) && statSync(full).isFile()) return full;
    }
    return null;
}

if (!existsSync(ROOT)) {
    console.error(`No build to serve at ${ROOT} — run \`npm run build\` first.`);
    process.exit(1);
}

createServer(selfSignedCert(), (req, res) => {
    const file = resolve(req.url || '/');
    if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
    }
    res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
    });
    res.end(readFileSync(file));
}).listen(PORT, 'localhost', () => {
    console.log(`dist served over https at https://localhost:${PORT}/`);
});
