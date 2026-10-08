'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { startServer, frame } = require('./helpers/ws-server');

const { WsClient } = require(path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin/ws-client.js'));

async function connect() {
  const server = await startServer();
  const client = new WsClient(`ws://127.0.0.1:${server.port}`);
  const [[peer]] = await Promise.all([once(server.events, 'connection'), once(client, 'open')]);
  return { server, client, peer };
}

test('text messages flow both ways and client frames are masked', async () => {
  const { server, client, peer } = await connect();
  client.send(JSON.stringify({ event: 'registerPlugin', uuid: 'u' }));
  const [msg] = await once(peer, 'message');
  assert.deepEqual(msg, { event: 'registerPlugin', uuid: 'u' });
  assert.equal(peer.unmasked, 0);

  peer.sendJson({ event: 'willAppear', context: '日本語コンテキスト' });
  const [raw] = await once(client, 'message');
  assert.deepEqual(JSON.parse(raw.toString()), { event: 'willAppear', context: '日本語コンテキスト' });
  client.close();
  await server.close();
});

test('large payloads use extended lengths in both directions', async () => {
  const { server, client, peer } = await connect();
  const big = 'x'.repeat(70000); // 64bit 長
  const mid = 'y'.repeat(3000); // 16bit 長
  client.send(JSON.stringify({ big }));
  assert.equal((await once(peer, 'message'))[0].big.length, 70000);
  peer.sendJson({ mid });
  assert.equal(JSON.parse((await once(client, 'message'))[0]).mid.length, 3000);
  peer.sendJson({ big });
  assert.equal(JSON.parse((await once(client, 'message'))[0]).big.length, 70000);
  client.close();
  await server.close();
});

test('fragmented and split frames are reassembled', async () => {
  const { server, client, peer } = await connect();
  const body = Buffer.from(JSON.stringify({ event: 'keyUp', context: 'k1' }));
  const wire = Buffer.concat([frame(0x1, body.subarray(0, 10), false), frame(0x0, body.subarray(10), true)]);
  // 1バイトずつ届いても組み立てられること
  for (const byte of wire) peer.sendRaw(Buffer.from([byte]));
  const [raw] = await once(client, 'message');
  assert.deepEqual(JSON.parse(raw.toString()), { event: 'keyUp', context: 'k1' });
  client.close();
  await server.close();
});

test('answers ping with pong and closes cleanly on close frame', async () => {
  const { server, client, peer } = await connect();
  peer.ping('hello');
  assert.equal((await once(peer, 'pong'))[0], 'hello');
  peer.close();
  await once(client, 'close');
  assert.equal(client.readyState, WsClient.CLOSED);
  assert.equal(client.send('{}'), false);
  await server.close();
});

test('emits error then close when nothing is listening', async () => {
  const server = await startServer();
  const port = server.port;
  await server.close();
  const client = new WsClient(`ws://127.0.0.1:${port}`);
  const errors = [];
  client.on('error', (err) => errors.push(err));
  // events.once は 'error' で reject するので close は手で待つ
  await new Promise((resolve) => client.on('close', resolve));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ECONNREFUSED');
});
