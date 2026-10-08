'use strict';

// テスト用の最小 WebSocket サーバ (VSD Craft の代役)。
// クライアントのフレームがマスクされていることも検査する。

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}

class Peer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.unmasked = 0;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.emit('close'));
    socket.on('error', () => {});
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const maskAt = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i += 1) payload[i] ^= b[maskAt + (i & 3)];
      else this.unmasked += 1;
      this.buffer = b.subarray(off + len);
      if (opcode === 0x1) this.emit('message', JSON.parse(payload.toString('utf8')));
      else if (opcode === 0xa) this.emit('pong', payload.toString('utf8'));
      else if (opcode === 0x8) { this.emit('closeFrame', payload); this.socket.end(); }
    }
  }

  sendJson(obj) { this.socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); }
  sendRaw(buf) { this.socket.write(buf); }
  ping(text) { this.socket.write(frame(0x9, Buffer.from(text))); }
  close() { this.socket.write(frame(0x8, Buffer.from([0x03, 0xe8]))); }
}

function startServer() {
  const server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
  const events = new EventEmitter();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    events.emit('connection', new Peer(socket));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ port: server.address().port, events, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}

module.exports = { startServer, frame };
