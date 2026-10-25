import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as net from 'node:net';

/** Only global unicast addresses; exclude local, metadata, transition and documentation ranges. */
export function publicAddress(address: string): boolean {
    if (net.isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
            || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
    }
    if (net.isIP(address) !== 6) return false;
    // Reject Teredo/6to4 and the IETF special-purpose block, including IPv4 translation.
    const first = parseInt(address.split(':')[0], 16);
    const second = parseInt(address.split(':')[1], 16) || 0;
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
        && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8));
}

async function publicTarget(host: string): Promise<string> {
    const normalized = host.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(normalized) ? [{ address: normalized }] : await dns.lookup(normalized, { all: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Private network');
    return addresses[0].address;
}

/** DNS is resolved here and the TCP connection uses that exact IP, closing the DNS rebinding gap. */
export function createBrowserProxy(): http.Server {
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '');
            if (url.protocol !== 'http:' || (url.port && url.port !== '80') || url.username || url.password) throw new Error('Invalid target');
            const address = await publicTarget(url.hostname);
            const { 'proxy-authorization': unused, 'proxy-connection': unused2, ...headers } = req.headers;
            headers.host = url.host;
            const upstream = http.request({ host: address, port: 80, method: req.method,
                path: url.pathname + url.search, headers, timeout: 30_000 }, response => {
                res.writeHead(response.statusCode || 502, response.headers);
                response.on('error', () => res.destroy());
                response.pipe(res);
            });
            upstream.on('timeout', () => upstream.destroy());
            upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
            req.on('aborted', () => upstream.destroy());
            req.pipe(upstream);
        } catch { req.resume(); res.writeHead(403); res.end(); }
    });
    server.on('connect', async (req, socket, head) => {
        let upstream: net.Socket | undefined;
        // Avoid unhandled socket errors even while DNS is pending.
        socket.on('error', () => upstream?.destroy());
        try {
            const url = new URL(`https://${req.url}`);
            if (url.port && url.port !== '443' || url.username || url.password || url.pathname !== '/') throw new Error('Invalid tunnel');
            const address = await publicTarget(url.hostname);
            if (socket.destroyed) return;
            upstream = net.createConnection({ host: address, port: 443 });
            upstream.setTimeout(60_000, () => upstream?.destroy());
            upstream.on('error', () => socket.destroy());
            upstream.on('close', () => socket.destroy());
            socket.on('close', () => upstream?.destroy());
            upstream.once('connect', () => {
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream!.write(head);
                socket.pipe(upstream!); upstream!.pipe(socket);
            });
        } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
    });
    server.maxConnections = 256;
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    return server;
}
