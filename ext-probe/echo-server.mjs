#!/usr/bin/env node
/**
 * Minimal loopback server for the Sideload Probe.
 *
 *   node echo-server.mjs
 *
 * Serves GET /health as JSON and upgrades any WebSocket connection to a plain
 * text echo. Binds to 127.0.0.1 only — it is not reachable from the network.
 * Zero npm dependencies: the WebSocket handshake and framing are implemented
 * here, so this runs where `npm install` is blocked.
 */
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455

const server = http.createServer((req, res) => {
  // The extension has host permission for 127.0.0.1, so CORS is not strictly
  // needed, but this keeps the endpoint testable from a normal page too.
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'sideload-probe echo', ok: true, pid: process.pid, time: new Date().toISOString() }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('try /health, or open a WebSocket to this port\n');
});

// ---- WebSocket: handshake ----

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  console.log(`ws open   from ${req.headers.origin || 'unknown origin'}`);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = decode(buf);
      if (!frame) break;
      buf = buf.subarray(frame.consumed);
      if (frame.opcode === 0x8) { socket.end(encode('', 0x8)); return; }   // close
      if (frame.opcode === 0x9) { socket.write(encode(frame.payload, 0xa)); continue; } // ping
      if (frame.opcode === 0x1) {
        const text = frame.payload.toString('utf8');
        console.log(`ws recv   ${text}`);
        socket.write(encode(`echo: ${text}`));
      }
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => console.log('ws close'));
});

// ---- WebSocket: framing ----

function decode(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > 1_000_000n) return null; // this is an echo toy, not a file transfer
    len = Number(big);
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  // Client-to-server frames are always masked (RFC 6455 §5.3).
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, consumed: offset + len };
}

function encode(data, opcode = 0x1) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]); // server frames are never masked
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`echo server on http://127.0.0.1:${PORT}  (health: /health, ws: same port)`);
  console.log('ctrl-c to stop');
});
