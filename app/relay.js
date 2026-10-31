#!/usr/bin/env node
// relay.js — TCP 转发工具 + 内置静态站点
//
// 一个进程同时做两件事：
//   1. 8443 端口：TCP 转发（给 Cloudflare Workers 用）
//   2. 8080 端口：HTTP 静态站点（伪装页，防止裸端口被扫）
//
// 环境变量：
//   PORT       转发端口（默认 8443）
//   HTTP_PORT  站点端口（默认 8080）
//   SITE_DIR   站点目录（默认 /app/site）

'use strict';

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = parseInt(process.env.PORT || '8443', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, 'site');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ═══════════════════════════════════════════
// 1. TCP 转发
// ═══════════════════════════════════════════

const server = net.createServer((client) => {
  client.setNoDelay(true);
  client.setTimeout(180000);

  let upstream = null;
  let handshook = false;
  let buf = Buffer.alloc(0);

  const fail = (msg) => {
    try { client.write(`ERR ${msg}\r\n`); } catch {}
    try { client.destroy(); } catch {}
    try { if (upstream) upstream.destroy(); } catch {}
  };

  const pipe = (sock, rest) => {
    upstream = sock;
    try { client.write('OK\r\n'); } catch {}
    if (rest && rest.length) sock.write(rest);
    sock.on('data', (d) => { if (!client.destroyed) client.write(d); });
    sock.on('close', () => { try { client.destroy(); } catch {} });
    sock.on('error', () => { try { client.destroy(); } catch {} });
    sock.on('timeout', () => { try { sock.destroy(); } catch {} });
  };

  const onData = (chunk) => {
    if (handshook) {
      if (upstream && !upstream.destroyed) upstream.write(chunk);
      return;
    }

    buf = Buffer.concat([buf, chunk]);

    if (buf.length >= 1 && buf[0] === 0x05) {
      handshook = true;
      handleSocks5(client, buf, (sock) => {
        upstream = sock;
        sock.on('data', (d) => { if (!client.destroyed) client.write(d); });
        sock.on('close', () => { try { client.destroy(); } catch {} });
        sock.on('error', () => { try { client.destroy(); } catch {} });
      });
      return;
    }

    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > 512) fail('header too long');
      return;
    }

    const line = buf.slice(0, nl).toString('utf8').trim();
    const rest = buf.slice(nl + 1);
    handshook = true;

    const m = line.match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) return fail('bad target');

    const host = m[1];
    const port = parseInt(m[2], 10);
    if (!(port > 0 && port < 65536)) return fail('bad port');

    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    sock.setTimeout(180000);
    sock.on('connect', () => pipe(sock, rest));
    sock.on('error', (e) => fail('connect ' + (e.code || 'error')));
    sock.on('timeout', () => fail('connect timeout'));
  };

  client.on('data', onData);
  client.on('error', () => {});
  client.on('timeout', () => { try { client.destroy(); } catch {} });
  client.on('close', () => { try { if (upstream) upstream.destroy(); } catch {} });
});

function handleSocks5(client, initial, onReady) {
  let stage = 0;
  let buf = initial;

  const pump = () => {
    if (stage === 0) {
      if (buf.length < 2) return;
      const n = buf[1];
      if (buf.length < 2 + n) return;
      client.write(Buffer.from([0x05, 0x00]));
      buf = buf.slice(2 + n);
      stage = 1;
      return pump();
    }

    if (stage === 1) {
      if (buf.length < 4) return;
      if (buf[1] !== 0x01) {
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }
      const atyp = buf[3];
      let addrLen;
      if (atyp === 0x01) addrLen = 4;
      else if (atyp === 0x04) addrLen = 16;
      else if (atyp === 0x03) {
        if (buf.length < 5) return;
        addrLen = 1 + buf[4];
      } else {
        client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }
      const need = 4 + addrLen + 2;
      if (buf.length < need) return;

      let host;
      if (atyp === 0x01) {
        host = Array.from(buf.slice(4, 8)).join('.');
      } else if (atyp === 0x04) {
        const seg = [];
        for (let i = 0; i < 16; i += 2) seg.push(buf.readUInt16BE(4 + i).toString(16));
        host = seg.join(':');
      } else {
        host = buf.slice(5, 5 + buf[4]).toString('utf8');
      }
      const port = buf.readUInt16BE(4 + addrLen);
      const rest = buf.slice(need);

      const sock = net.createConnection({ host, port });
      sock.setNoDelay(true);
      sock.setTimeout(180000);
      sock.on('connect', () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (rest.length) sock.write(rest);
        onReady(sock);
      });
      sock.on('error', () => {
        try { client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
        client.destroy();
      });
      stage = 2;
      return;
    }
  };

  client.removeAllListeners('data');
  client.on('data', (c) => {
    if (stage === 2) return;
    buf = Buffer.concat([buf, c]);
    pump();
  });

  pump();
}

// ═══════════════════════════════════════════
// 2. 静态站点（伪装页）
// ═══════════════════════════════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function safeJoin(root, reqPath) {
  const clean = decodeURIComponent(reqPath.split('?')[0].split('#')[0]);
  const target = path.normalize(path.join(root, clean));
  if (!target.startsWith(path.normalize(root))) return null;
  return target;
}

const web = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  let filePath = safeJoin(SITE_DIR, req.url === '/' ? '/index.html' : req.url);

  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // 单页应用回退
      filePath = path.join(SITE_DIR, 'index.html');
      fs.stat(filePath, (e2, st2) => {
        if (e2 || !st2.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        sendFile(filePath, res);
      });
      return;
    }
    sendFile(filePath, res);
  });
});

function sendFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// ═══════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  log(`relay listening on 0.0.0.0:${PORT}`);
});

web.listen(HTTP_PORT, '0.0.0.0', () => {
  log(`site listening on 0.0.0.0:${HTTP_PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(sig);
    server.close();
    web.close();
    setTimeout(() => process.exit(0), 3000);
  });
}
