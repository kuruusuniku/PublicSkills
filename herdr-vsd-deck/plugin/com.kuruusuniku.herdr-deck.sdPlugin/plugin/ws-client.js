'use strict';

// VSD Craft の組み込み Node (v20) には WebSocket クライアントが無いので、
// プラグイン用ローカルソケットに必要な分だけ RFC 6455 を実装する。
// npm install 不要でフォルダをコピーするだけで動かすための自前実装。

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class WsClient extends EventEmitter {
  constructor(url) {
    super();
    this.readyState = CONNECTING;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closing = false;

    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request(url.replace(/^ws:/, 'http:'), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this.fail(new Error('websocket handshake rejected'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('close', () => this.finish());
      socket.on('error', (err) => this.fail(err));
      this.readyState = OPEN;
      this.emit('open');
      if (head && head.length) this.onData(head);
    });
    req.on('response', (res) => {
      res.resume();
      this.fail(new Error(`websocket upgrade refused: HTTP ${res.statusCode}`));
    });
    req.on('error', (err) => this.fail(err));
    req.end();
  }

  send(text) {
    if (this.readyState !== OPEN || this.closing) return false;
    this.writeFrame(0x1, Buffer.from(text, 'utf8'));
    return true;
  }

  close() {
    if (this.readyState !== OPEN || this.closing) return;
    this.closing = true;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000, 0);
    this.writeFrame(0x8, code);
    this.socket.end();
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buf.length < offset + length) return;

      let payload = Buffer.from(buf.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= buf[maskAt + (i & 3)];
      }
      this.buffer = buf.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
      if (this.readyState === CLOSED) return;
    }
  }

  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close
        if (!this.closing) {
          this.closing = true;
          this.writeFrame(0x8, payload.subarray(0, 2));
          this.socket.end();
        }
        return;
      case 0x9: // ping
        this.writeFrame(0xa, payload);
        return;
      case 0xa: // pong
        return;
      case 0x0:
      case 0x1:
      case 0x2:
        this.fragments.push(payload);
        if (!fin) return;
        {
          const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', message);
        }
        return;
      default:
        this.fail(new Error(`unknown websocket opcode ${opcode}`));
    }
  }

  // クライアント→サーバのフレームは必ずマスクする (RFC 6455 5.3)。
  writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const body = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) body[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  fail(err) {
    if (this.readyState === CLOSED) return;
    if (this.listenerCount('error')) this.emit('error', err);
    if (this.socket) this.socket.destroy();
    this.finish();
  }

  finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }
}

WsClient.OPEN = OPEN;
WsClient.CLOSED = CLOSED;

module.exports = { WsClient };
