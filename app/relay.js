#!/usr/bin/env node
// relay.js — TCP 转发工具
//
// 客户端连上后发送  <host>:<port>\r\n
// 服务端回 OK\r\n，之后进入纯字节流双向转发
// 同时兼容 SOCKS5（首字节 0x05 自动识别）
//
// 环境变量：
//   PORT  监听端口（默认 8443）

'use strict';

const net = require('node:net');

const PORT = parseInt(process.env.PORT || '8443', 10);
const HOST = '0.0.0.0';

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

    // SOCKS5
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

    // 文本协议
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

server.listen(PORT, HOST, () => {
  log(`relay listening on ${HOST}:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(sig);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
