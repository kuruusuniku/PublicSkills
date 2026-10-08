'use strict';

// index.js の Deck (VSD Craft のイベント処理) と、実プロセスでの E2E テスト

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { startServer } = require('./helpers/ws-server');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { Deck, parseArgs, describeError, AGENT_ACTION, SUMMARY_ACTION } = require(path.join(PLUGIN, 'index.js'));
const { ConfigStore } = require(path.join(PLUGIN, 'config.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot.json'), 'utf8')).result.snapshot;
const svgOf = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));

function makeDeck({ snap = snapshot, failWith = null, raiseFails = false } = {}) {
  const sent = [];
  const calls = { focus: [], raise: [] };
  const herdr = {
    snapshot: async () => {
      if (failWith) throw failWith;
      return snap;
    },
    focusAgent: async (paneId) => { calls.focus.push(paneId); },
  };
  const config = new ConfigStore(path.join(os.tmpdir(), `no-such-config-${process.pid}.json`));
  const deck = new Deck({
    send: (m) => sent.push(m),
    config,
    createHerdr: () => herdr,
    raise: async (app) => {
      calls.raise.push(app);
      if (raiseFails) throw new Error('no terminal');
      return 'Ghostty';
    },
    now: () => 600000,
    logger: () => {},
  });
  return { deck, sent, calls };
}

const appear = (deck, context, action, row, column, controller = 'Keypad') =>
  deck.handle({ event: 'willAppear', action, context, device: 'dev', payload: { coordinates: { row, column }, controller, settings: {} } });

const lastImage = (sent, context) => [...sent].reverse().find((m) => m.event === 'setImage' && m.context === context)?.payload.image;

test('parseArgs reads the VSD Craft launch flags', () => {
  assert.deepEqual(parseArgs(['node', 'index.js', '-port', '1234', '-pluginUUID', 'abc', '-registerEvent', 'registerPlugin', '-info', '{}']),
    { port: '1234', pluginUUID: 'abc', registerEvent: 'registerPlugin' });
});

test('agent keys show agents in key-position order and jump on press', async () => {
  const { deck, sent, calls } = makeDeck();
  // わざと逆順に置く: 番号はキーの位置で決まる
  appear(deck, 'k3', AGENT_ACTION, 0, 2);
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  appear(deck, 'k2', AGENT_ACTION, 0, 1);
  appear(deck, 'k4', AGENT_ACTION, 1, 0);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'k1')), />作業中</);
  assert.match(svgOf(lastImage(sent, 'k2')), />確認待ち</);
  assert.match(svgOf(lastImage(sent, 'k3')), />完了</);
  assert.match(svgOf(lastImage(sent, 'k4')), />空き</);

  await deck.handle({ event: 'keyUp', action: AGENT_ACTION, context: 'k3', payload: {} });
  assert.deepEqual(calls.focus, ['w2:p1']);
  assert.deepEqual(calls.raise, ['']);

  await deck.handle({ event: 'keyUp', action: AGENT_ACTION, context: 'k4', payload: {} });
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 'k4' });
});

test('images are only sent when they change', async () => {
  const { deck, sent } = makeDeck();
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  await deck.refresh();
  const before = sent.length;
  await deck.refresh();
  assert.equal(sent.length, before);
  deck.animate();
  assert.equal(sent.length, before + 1);
});

test('summary key counts agents and jumps to the most urgent one', async () => {
  const { deck, sent, calls } = makeDeck();
  appear(deck, 's1', SUMMARY_ACTION, 0, 0);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 's1')), />herdr {2}3体</);
  await deck.handle({ event: 'keyUp', action: SUMMARY_ACTION, context: 's1', payload: {} });
  assert.deepEqual(calls.focus, ['w1:p2']);
});

test('summary on a knob selects with rotation and jumps on press', async () => {
  const { deck, sent, calls } = makeDeck();
  appear(deck, 'n1', SUMMARY_ACTION, 0, 0, 'Knob');
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'n1')), />作業中</);
  deck.handle({ event: 'dialRotate', action: SUMMARY_ACTION, context: 'n1', payload: { ticks: -1 } });
  assert.match(svgOf(lastImage(sent, 'n1')), />完了</);
  await deck.handle({ event: 'dialDown', action: SUMMARY_ACTION, context: 'n1', payload: {} });
  assert.deepEqual(calls.focus, ['w2:p1']);
});

test('herdr errors are shown on every key and presses alert', async () => {
  const { deck, sent, calls } = makeDeck({ failWith: new Error('no herdr server is running at /x; run `herdr`') });
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  appear(deck, 's1', SUMMARY_ACTION, 0, 1);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'k1')), />herdr 未接続</);
  assert.match(svgOf(lastImage(sent, 's1')), />herdr 未接続</);
  await deck.handle({ event: 'keyUp', action: AGENT_ACTION, context: 'k1', payload: {} });
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 'k1' });
  assert.deepEqual(calls.focus, []);
});

test('a terminal that cannot be raised still counts as a jump inside herdr', async () => {
  const { deck, sent, calls } = makeDeck({ raiseFails: true });
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  await deck.refresh();
  await deck.handle({ event: 'keyUp', action: AGENT_ACTION, context: 'k1', payload: {} });
  assert.deepEqual(calls.focus, ['w1:p1']);
  assert.equal(sent.some((m) => m.event === 'showAlert'), false);
});

test('removing a key renumbers the remaining ones', async () => {
  const { deck, sent } = makeDeck();
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  appear(deck, 'k2', AGENT_ACTION, 0, 1);
  await deck.refresh();
  deck.handle({ event: 'willDisappear', action: AGENT_ACTION, context: 'k1', payload: {} });
  assert.match(svgOf(lastImage(sent, 'k2')), />作業中</);
});

test('describeError maps herdr failures to short key messages', () => {
  assert.deepEqual(describeError(Object.assign(new Error('x'), { code: 'HERDR_NOT_FOUND' }))[0], 'herdr が見つかりません');
  assert.equal(describeError(Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' }))[0], 'herdr が見つかりません');
  assert.equal(describeError(new Error('no herdr server is running at /x; run `herdr` to start or attach it'))[0], 'herdr 未接続');
  assert.equal(describeError(new Error('something else'))[0], 'herdr エラー');
  assert.equal(describeError(Object.assign(new Error('Command failed'), { killed: true }))[0], 'herdr 応答なし');
});

test('end to end: VSD Craft launches the plugin, keys render, a press focuses herdr', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-'));
  const config = path.join(tmp, 'config.json');
  const herdrLog = path.join(tmp, 'herdr.log');
  fs.writeFileSync(config, JSON.stringify({ herdr: { bin: path.join(FIXTURES, 'fake-herdr.js') }, deck: { pollMs: 300, frameMs: 200 } }));
  const server = await startServer();
  const child = spawn(process.execPath, [path.join(PLUGIN, 'index.js'), '-port', String(server.port), '-pluginUUID', 'UUID-1', '-registerEvent', 'registerPlugin', '-info', '{}'], {
    env: { ...process.env, HERDR_VSD_DECK_CONFIG: config, FAKE_HERDR_SNAPSHOT: path.join(FIXTURES, 'snapshot.json'), FAKE_HERDR_LOG: herdrLog },
    stdio: 'ignore',
  });
  t.after(() => { child.kill(); fs.rmSync(path.join(PLUGIN, 'log'), { recursive: true, force: true }); });

  const [peer] = await once(server.events, 'connection');
  const messages = [];
  peer.on('message', (m) => messages.push(m));
  const waitFor = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting for message');
  };

  assert.deepEqual(await waitFor(() => true), { event: 'registerPlugin', uuid: 'UUID-1' });
  peer.sendJson({ event: 'willAppear', action: AGENT_ACTION, context: 'k1', device: 'd', payload: { coordinates: { row: 0, column: 0 }, controller: 'Keypad' } });
  peer.sendJson({ event: 'willAppear', action: AGENT_ACTION, context: 'k2', device: 'd', payload: { coordinates: { row: 0, column: 1 }, controller: 'Keypad' } });
  await waitFor((m) => m.event === 'setImage' && m.context === 'k2' && svgOf(m.payload.image).includes('確認待ち'));
  peer.sendJson({ event: 'keyUp', action: AGENT_ACTION, context: 'k2', payload: {} });
  const end = Date.now() + 5000;
  while (Date.now() < end && !(fs.existsSync(herdrLog) && fs.readFileSync(herdrLog, 'utf8').includes('agent focus w1:p2'))) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.match(fs.readFileSync(herdrLog, 'utf8'), /agent focus w1:p2/);

  // VSD Craft がソケットを閉じたらプラグインも終了する
  peer.close();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  await server.close();
});
