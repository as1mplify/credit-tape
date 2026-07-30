#!/usr/bin/env node
/** Dependency-free static server for local preview. Run: npm run dev */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));

    // Never serve outside public/
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) path = join(path, 'index.html');

    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Credit Tape running at http://localhost:${PORT}`);
});
