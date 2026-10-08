'use strict';

// index.js の Deck (VSD Craft のイベント処理) と、実プロセスでの E2E テスト

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { startServer } = require('./helpers/ws-server');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { Deck, parseArgs, describeError, AGENT_ACTION, SUMMARY_ACTION, NEXT_ACTION, MUTE_ACTION } = require(path.join(PLUGIN, 'index.js'));
const { ConfigStore } = require(path.join(PLUGIN, 'config.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot.json'), 'utf8')).result.snapshot;
const svgOf = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
const bgOf = (uri) => svgOf(uri).match(/<rect width="64" height="64" fill="([^"]+)"/)?.[1];

function makeDeck({ snap = snapshot, failWith = null, raiseFails = false, deck: deckConfig = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-unit-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ deck: deckConfig }));
  const sent = [];
  const calls = { focus: [], raise: [], led: [], ledClosed: 0 };
  let current = snap;
  const herdr = {
    snapshot: async () => {
      if (failWith) throw failWith;
      return current;
    },
    focusAgent: async (paneId) => { calls.focus.push(paneId); },
  };
  const deck = new Deck({
    send: (m) => sent.push(m),
    config: new ConfigStore(configFile),
    createHerdr: () => herdr,
    createLed: () => ({ show: (rgb) => calls.led.push(rgb.join(',')), close: () => { calls.ledClosed += 1; } }),
    raise: async (app) => {
      calls.raise.push(app);
      if (raiseFails) throw new Error('no terminal');
      return 'Ghostty';
    },
    muteFile: path.join(dir, 'mute'),
    now: () => 600000,
    logger: () => {},
  });
  const setSnapshot = (next) => { current = next; };
  const setConfig = (deckOverrides) => {
    fs.writeFileSync(configFile, JSON.stringify({ deck: deckOverrides }));
    fs.utimesSync(configFile, new Date(), new Date(Date.now() + 10000));
  };
  return { deck, sent, calls, dir, setSnapshot, setConfig };
}

const appear = (deck, context, action, row, column, controller = 'Keypad') =>
  deck.handle({ event: 'willAppear', action, context, device: 'dev', payload: { coordinates: { row, column }, controller, settings: {} } });

const press = (deck, context, action) => deck.handle({ event: 'keyUp', action, context, payload: {} });

const lastImage = (sent, context) => [...sent].reverse().find((m) => m.event === 'setImage' && m.context === context)?.payload.image;

test('parseArgs reads the VSD Craft launch flags', () => {
  assert.deepEqual(parseArgs(['node', 'index.js', '-port', '1234', '-pluginUUID', 'abc', '-registerEvent', 'registerPlugin', '-info', '{}']),
    { port: '1234', pluginUUID: 'abc', registerEvent: 'registerPlugin' });
});

test('compact layout (default, 64px keys) fills keys with the status colour', async () => {
  const { deck, sent } = makeDeck();
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  appear(deck, 'k2', AGENT_ACTION, 0, 1);
  appear(deck, 'k3', AGENT_ACTION, 0, 2);
  appear(deck, 'k4', AGENT_ACTION, 0, 3);
  appear(deck, 's1', SUMMARY_ACTION, 0, 4);
  await deck.refresh();
  assert.equal(bgOf(lastImage(sent, 'k1')), '#1d4ed8');
  assert.match(bgOf(lastImage(sent, 'k2')), /^#(b45309|ea580c)$/);
  assert.equal(bgOf(lastImage(sent, 'k3')), '#15803d');
  assert.match(svgOf(lastImage(sent, 'k1')), /viewBox="0 0 64 64"/);
  assert.match(svgOf(lastImage(sent, 'k1')), />api main</);
  assert.match(svgOf(lastImage(sent, 'k2')), />reviewer</);
  assert.match(svgOf(lastImage(sent, 'k4')), />#4</);
  const summary = svgOf(lastImage(sent, 's1'));
  assert.equal((summary.match(/>1</g) || []).length, 3, 'blocked / working / done counts');
});

test('agent keys show agents in key-position order and jump on press', async () => {
  const { deck, sent, calls } = makeDeck({ deck: { layout: 'detailed' } });
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

  await press(deck, 'k3', AGENT_ACTION);
  assert.deepEqual(calls.focus, ['w2:p1']);
  assert.deepEqual(calls.raise, ['']);

  await press(deck, 'k4', AGENT_ACTION);
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

test('summary key jumps to the most urgent agent, also from a screenless button', async () => {
  const { deck, sent, calls } = makeDeck({ deck: { layout: 'detailed' } });
  appear(deck, 's1', SUMMARY_ACTION, 0, 0);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 's1')), />herdr {2}3体</);
  await press(deck, 's1', SUMMARY_ACTION);
  assert.deepEqual(calls.focus, ['w1:p2']);
});

test('next cycles blocked -> done -> working starting after the focused agent', async () => {
  const { deck, sent, calls, setSnapshot } = makeDeck();
  appear(deck, 'n1', NEXT_ACTION, 2, 0);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'n1')), />次へ</);
  assert.match(svgOf(lastImage(sent, 'n1')), />2</, 'blocked + done badge');
  // フィクスチャでは作業中の w1:p1 がフォーカス中 → 急ぎ順 [w1:p2, w2:p1, w1:p1] の先頭へ戻る
  await press(deck, 'n1', NEXT_ACTION);
  assert.deepEqual(calls.focus, ['w1:p2']);
  const focusOn = (paneId) => ({ ...snapshot, agents: snapshot.agents.map((a) => ({ ...a, focused: a.pane_id === paneId })) });
  setSnapshot(focusOn('w1:p2'));
  await deck.refresh();
  await press(deck, 'n1', NEXT_ACTION);
  assert.deepEqual(calls.focus, ['w1:p2', 'w2:p1']);
});

test('mute button toggles the shared mute file even while herdr is down', async () => {
  const { deck, sent, dir } = makeDeck({ failWith: new Error('no herdr server is running') });
  appear(deck, 'm1', MUTE_ACTION, 2, 2);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'm1')), />読み上げ</);
  await press(deck, 'm1', MUTE_ACTION);
  assert.ok(fs.existsSync(path.join(dir, 'mute')));
  assert.match(svgOf(lastImage(sent, 'm1')), />ミュート</);
  await press(deck, 'm1', MUTE_ACTION);
  assert.ok(!fs.existsSync(path.join(dir, 'mute')));
  assert.match(svgOf(lastImage(sent, 'm1')), />読み上げ</);
  // フック側など外から消されても次の更新で反映される
  fs.writeFileSync(path.join(dir, 'mute'), '');
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'm1')), />ミュート</);
});

test('summary on a knob selects with rotation and jumps on press', async () => {
  const { deck, sent, calls } = makeDeck({ deck: { layout: 'detailed' } });
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
  appear(deck, 'n1', NEXT_ACTION, 0, 2);
  await deck.refresh();
  for (const key of ['k1', 's1', 'n1']) assert.match(svgOf(lastImage(sent, key)), />未接続</);
  await press(deck, 'k1', AGENT_ACTION);
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 'k1' });
  await press(deck, 'n1', NEXT_ACTION);
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 'n1' });
  assert.deepEqual(calls.focus, []);
});

test('LED ring follows the most urgent status and turns off when disabled', async () => {
  const { deck, calls, setConfig, setSnapshot } = makeDeck({ deck: { ledRing: true } });
  await deck.refresh();
  deck.animate();
  deck.animate();
  assert.deepEqual([...calls.led].sort(), ['255,110,0', '70,30,0'], 'blocked pulses orange');
  setSnapshot({ ...snapshot, agents: snapshot.agents.filter((a) => a.agent_status !== 'blocked') });
  await deck.refresh();
  deck.animate();
  assert.equal(calls.led.at(-1), '0,200,60', 'then done is green');
  setConfig({ ledRing: false });
  await deck.refresh();
  deck.animate();
  assert.equal(calls.led.at(-1), '0,0,0');
  assert.equal(calls.ledClosed, 1);
});

test('LED is never touched unless enabled', async () => {
  const { deck, calls } = makeDeck();
  await deck.refresh();
  deck.animate();
  assert.deepEqual(calls.led, []);
});

test('a terminal that cannot be raised still counts as a jump inside herdr', async () => {
  const { deck, sent, calls } = makeDeck({ raiseFails: true });
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  await deck.refresh();
  await press(deck, 'k1', AGENT_ACTION);
  assert.deepEqual(calls.focus, ['w1:p1']);
  assert.equal(sent.some((m) => m.event === 'showAlert'), false);
});

test('removing a key renumbers the remaining ones', async () => {
  const { deck, sent } = makeDeck({ deck: { layout: 'detailed' } });
  appear(deck, 'k1', AGENT_ACTION, 0, 0);
  appear(deck, 'k2', AGENT_ACTION, 0, 1);
  await deck.refresh();
  deck.handle({ event: 'willDisappear', action: AGENT_ACTION, context: 'k1', payload: {} });
  assert.match(svgOf(lastImage(sent, 'k2')), />作業中</);
});

test('describeError maps herdr failures to short key messages', () => {
  assert.deepEqual(describeError(Object.assign(new Error('x'), { code: 'HERDR_NOT_FOUND' })), ['herdr が見つかりません', 'config の herdr.bin を設定', '見つからず']);
  assert.equal(describeError(Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' }))[0], 'herdr が見つかりません');
  assert.equal(describeError(new Error('no herdr server is running at /x; run `herdr` to start or attach it'))[2], '未接続');
  assert.equal(describeError(Object.assign(new Error('Command failed'), { killed: true }))[0], 'herdr 応答なし');
  assert.equal(describeError(new Error('something else'))[0], 'herdr エラー');
});

test('index.js also starts when run as a shell script (VSD Craft without built-in Node)', () => {
  const run = spawnSync('/bin/sh', [path.join(PLUGIN, 'index.js')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node index\.js/);
  const mode = fs.statSync(path.join(PLUGIN, 'index.js')).mode;
  assert.ok(mode & 0o111, 'index.js is executable');
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
  t.after(async () => {
    child.kill();
    await server.close();
    fs.rmSync(path.join(PLUGIN, 'log'), { recursive: true, force: true });
  });

  const [peer] = await once(server.events, 'connection');
  const messages = [];
  peer.on('message', (m) => messages.push(m));
  const waitFor = async (pred, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  assert.deepEqual(await waitFor(() => true, 'registration'), { event: 'registerPlugin', uuid: 'UUID-1' });
  peer.sendJson({ event: 'willAppear', action: AGENT_ACTION, context: 'k1', device: 'd', payload: { coordinates: { row: 0, column: 0 }, controller: 'Keypad' } });
  peer.sendJson({ event: 'willAppear', action: AGENT_ACTION, context: 'k2', device: 'd', payload: { coordinates: { row: 0, column: 1 }, controller: 'Keypad' } });
  await waitFor((m) => m.event === 'setImage' && m.context === 'k2' && svgOf(m.payload.image).includes('reviewer'), 'the blocked agent on k2');
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
});
