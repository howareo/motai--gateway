import http from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model-state.mjs', ['model-state.mjs', 'text/javascript; charset=utf-8']],
  ['/motai-mark.svg', ['../../public/motai-mark.svg', 'image/svg+xml']],
]);

http.createServer(async (req, res) => {
  const asset = assets.get(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(500).end('Preview asset unavailable'); }
}).listen(8791, '127.0.0.1', () => process.stdout.write('Motai design preview: http://127.0.0.1:8791/\n'));
