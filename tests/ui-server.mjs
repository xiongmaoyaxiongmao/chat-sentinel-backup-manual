import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = new Map([
    ['/', ['tests/ui-fixture.html', 'text/html; charset=utf-8']],
    ['/ui-fixture.js', ['tests/ui-fixture.js', 'text/javascript; charset=utf-8']],
    ['/manager.html', ['extensions/chat-sentinel-backup/manager.html', 'text/html; charset=utf-8']],
    ['/style.css', ['extensions/chat-sentinel-backup/style.css', 'text/css; charset=utf-8']],
]);

const server = http.createServer(async (request, response) => {
    let route = routes.get(request.url);
    if (!route && request.url.startsWith('/src/')) {
        route = [`extensions/chat-sentinel-backup${request.url}`, 'text/javascript; charset=utf-8'];
    }
    if (!route) {
        response.writeHead(404).end('Not found');
        return;
    }
    try {
        const body = await readFile(path.join(root, route[0]));
        response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }).end(body);
    } catch (error) {
        response.writeHead(500).end(error.message);
    }
});

const port = Number(process.env.SENTINEL_UI_PORT || 4179);
server.listen(port, '127.0.0.1', () => {
    console.log(`Sentinel UI fixture: http://127.0.0.1:${port}/`);
});
