/**
 * HTTPS dev server for Next.js
 *
 * Needed so service workers work on flyx-dev.local (SW requires HTTPS for
 * non-localhost origins). Uses a self-signed cert trusted in the local root.
 *
 * Usage: node server-https.mjs
 * Then:  https://flyx-dev.local:3000/debug/megaup-keystream
 */

import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'flyx-dev.local';
const port = 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Read PFX
const pfx = readFileSync('cert.pfx');

app.prepare().then(() => {
  createServer({ pfx, passphrase: 'flyxdev' }, (req, res) => {
    handle(req, res);
  }).listen(port, () => {
    console.log(`  ▲ Next.js HTTPS server running at:`);
    console.log(`    https://${hostname}:${port}`);
  });
});
