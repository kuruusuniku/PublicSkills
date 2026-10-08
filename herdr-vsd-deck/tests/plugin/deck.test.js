'use strict';

// index.js の Deck (VSD Craft のイベント処理) と、実プロセスでの E2E テスト。
// ボタンは VSD M18 と同じく 上段5つをスペース、残り10個をタブ にして試す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { startServer } = require('./helpers/ws-server');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { Deck, parseArgs, parseSlot, describeError, SPACE_ACTION, TAB_ACTION, SUMMARY_ACTION, NEXT_ACTION, MUTE_ACTION } = require(path.join(PLUGIN, 'index.js'));
const { ConfigStore } = require(path.join(PLUGIN, 'config.js'));
const { STATE } = require(path.join(PLUGIN, 'render.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot.json'), 'utf8')).result.snapshot;
const svgOf = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
const bgOf = (uri) => svgOf(uri).match(/<rect width="64" height="64" rx="5" fill="([^"]+)"/)?.[1];
const clone = (x) => JSON.parse(JSON.stringify(x));

function makeDeck({ snap = snapshot, failWith = null, raiseFails = false, deck: deckConfig = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-unit-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ deck: deckConfig }));
  const sent = [];
  const calls = { herdr: [], raise: [], led: [], ledClosed: 0, observed: 0 };
  let current = snap;
  const herdr = {
    snapshot: async () => {
      if (failWith) throw failWith;
      return current;
    },
    focusTab: async (id) => { calls.herdr.push(`tab ${id}`); },
    focusWorkspace: async (id) => { calls.herdr.push(`workspace ${id}`); },
  };
  const deck = new Deck({
    send: (m) => sent.push(m),
    config: new ConfigStore(configFile),
    createHerdr: () => herdr,
    createLed: () => ({ show: (rgb) => calls.led.push(rgb.join(',')), close: () => { calls.ledClosed += 1; } }),
    createVoice: () => ({ observe: () => { calls.observed += 1; } }),
    raise: async (app) => {
      calls.raise.push(app);
      if (raiseFails) throw new Error('no terminal');
      return 'Ghostty';
    },
    muteFile: path.join(dir, 'mute'),
    logger: () => {},
  });
  const setSnapshot = (next) => { current = next; };
  const setConfig = (deckOverrides) => {
    fs.writeFileSync(configFile, JSON.stringify({ deck: deckOverrides }));
    fs.utimesSync(configFile, new Date(), new Date(Date.now() + 10000));
  };
  return { deck, sent, calls, dir, setSnapshot, setConfig };
}

const appear = (deck, context, action, row, column, { controller = 'Keypad', slot } = {}) =>
  deck.handle({ event: 'willAppear', action, context, device: 'M18', payload: { coordinates: { row, column }, controller, settings: slot ? { slot } : {} } });

const press = (deck, context, action) => deck.handle({ event: 'keyUp', action, context, payload: {} });
const lastImage = (sent, context) => [...sent].reverse().find((m) => m.event === 'setImage' && m.context === context)?.payload.image;
const label = (sent, context) => svgOf(lastImage(sent, context)).match(/fill="(?:#ffffff|#1e1b4b)">([^<]*)</)?.[1] ?? null;

// M18: 上段5つ=スペース、2・3段目=タブ (10個)
function layoutM18(deck, { tabKeys = 10 } = {}) {
  for (let c = 0; c < 5; c += 1) appear(deck, `s${c}`, SPACE_ACTION, 0, c);
  for (let i = 0; i < tabKeys; i += 1) appear(deck, `t${i}`, TAB_ACTION, 1 + Math.floor(i / 5), i % 5);
}

test('parseArgs and slot parsing', () => {
  assert.deepEqual(parseArgs(['node', 'index.js', '-port', '1234', '-pluginUUID', 'abc', '-registerEvent', 'registerPlugin', '-info', '{}']),
    { port: '1234', pluginUUID: 'abc', registerEvent: 'registerPlugin' });
  assert.equal(parseSlot('3'), 3);
  assert.equal(parseSlot(16), 16);
  assert.equal(parseSlot(''), null);
  assert.equal(parseSlot('17'), null);
});

test('top row shows spaces, the rest shows the tabs of the selected space', async () => {
  const { deck, sent, calls } = makeDeck();
  layoutM18(deck);
  await deck.refresh();
  assert.deepEqual(['s0', 's2'].map((k) => label(sent, k)), ['業務自動化', '執筆作業']);
  assert.match(svgOf(lastImage(sent, 's1')), />herdr-<[\s\S]*>stream…</, 'long words wrap after the hyphen');
  assert.equal(bgOf(lastImage(sent, 's3')), '#0d0b14', 'no fourth space');
  // 選んでいるスペース (herdr でフォーカス中の w1) は淡い色
  assert.equal(bgOf(lastImage(sent, 's0')), STATE.blocked.pale);
  assert.equal(bgOf(lastImage(sent, 's1')), STATE.idle.dark);
  assert.deepEqual(['t0', 't1', 't2', 't3', 't4'].map((k) => label(sent, k)), ['工数入力', 'DB移行', '手順書', 'console', '調査']);
  // herdr でアクティブなタブも淡い色、他は暗い状態色
  assert.equal(bgOf(lastImage(sent, 't0')), STATE.working.pale);
  assert.equal(bgOf(lastImage(sent, 't1')), STATE.blocked.dark);
  assert.equal(bgOf(lastImage(sent, 't2')), STATE.done.dark);
  assert.equal(bgOf(lastImage(sent, 't3')), STATE.none.dark);
  assert.equal(bgOf(lastImage(sent, 't5')), '#0d0b14');
  assert.equal(calls.observed, 1, 'the voice sees every refresh');
});

test('pressing a space selects it in herdr; pressing a tab jumps to it', async () => {
  const { deck, sent, calls } = makeDeck();
  layoutM18(deck);
  await deck.refresh();
  await press(deck, 's1', SPACE_ACTION);
  assert.deepEqual(calls.herdr, ['workspace w2']);
  assert.deepEqual(calls.raise, ['']);
  assert.equal(label(sent, 't0'), 'claude');
  assert.equal(bgOf(lastImage(sent, 't1')), '#0d0b14');
  assert.equal(bgOf(lastImage(sent, 's1')), STATE.idle.pale);
  assert.equal(bgOf(lastImage(sent, 's0')), STATE.blocked.dark);
  await press(deck, 't0', TAB_ACTION);
  assert.deepEqual(calls.herdr, ['workspace w2', 'tab w2:t1']);
  await press(deck, 't3', TAB_ACTION);
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 't3' }, 'empty tab slot');
});

test('pressing the selected space again pages through its tabs', async () => {
  const { deck, sent, calls } = makeDeck();
  layoutM18(deck, { tabKeys: 4 }); // Stream Deck Neo と同じ 4 タブ分
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 's0')), />1\/2</);
  await press(deck, 's0', SPACE_ACTION);
  assert.deepEqual(calls.herdr, [], 'paging does not touch herdr');
  assert.equal(label(sent, 't0'), '調査');
  assert.equal(bgOf(lastImage(sent, 't1')), '#0d0b14');
  assert.match(svgOf(lastImage(sent, 's0')), />2\/2</);
  await press(deck, 's0', SPACE_ACTION);
  assert.equal(label(sent, 't0'), '工数入力', 'wraps to the first page');
});

test('jumping to a tab on another page turns to that page', async () => {
  const { deck, sent } = makeDeck();
  layoutM18(deck, { tabKeys: 4 });
  await deck.refresh();
  deck.selectSpace('w1', 'w1:t5');
  deck.paintAll();
  assert.equal(label(sent, 't0'), '調査');
});

test('the deck follows when the space is switched inside herdr', async () => {
  const { deck, sent, setSnapshot } = makeDeck();
  layoutM18(deck);
  await deck.refresh();
  const moved = clone(snapshot);
  moved.focused_workspace_id = 'w3';
  setSnapshot(moved);
  await deck.refresh();
  assert.equal(label(sent, 't0'), '1');
  assert.equal(bgOf(lastImage(sent, 't0')), STATE.none.pale, 'an empty seat that is the active tab');
});

test('slots from the property inspector override the position order', async () => {
  const { deck, sent } = makeDeck();
  appear(deck, 'p2s1', SPACE_ACTION, 0, 0, { slot: 3 });
  appear(deck, 'p2s2', SPACE_ACTION, 0, 1, { slot: '2' });
  await deck.refresh();
  assert.equal(label(sent, 'p2s1'), '執筆作業');
  assert.equal(label(sent, 'p2s2'), 'herdr-');
  deck.handle({ event: 'didReceiveSettings', action: SPACE_ACTION, context: 'p2s1', payload: { settings: { slot: 1 } } });
  assert.equal(label(sent, 'p2s1'), '業務自動化');
});

test('summary jumps to the most urgent tab, next cycles in urgency order', async () => {
  const { deck, calls, setSnapshot } = makeDeck();
  appear(deck, 'b0', SUMMARY_ACTION, 3, 0);
  appear(deck, 'b1', NEXT_ACTION, 3, 1);
  await deck.refresh();
  await press(deck, 'b0', SUMMARY_ACTION);
  assert.deepEqual(calls.herdr, ['tab w1:t2']);
  // フィクスチャでは w1:t1 (作業中) がフォーカス中 → 急ぎ順 [t2, t3, t1, t5, w2:t1] で t1 の次は t5
  await press(deck, 'b1', NEXT_ACTION);
  assert.equal(calls.herdr.at(-1), 'tab w1:t5');
  const focused = clone(snapshot);
  focused.focused_tab_id = 'w2:t1';
  setSnapshot(focused);
  await deck.refresh();
  await press(deck, 'b1', NEXT_ACTION);
  assert.equal(calls.herdr.at(-1), 'tab w1:t2', 'wraps around');
});

test('mute button toggles the shared mute file even while herdr is down', async () => {
  const { deck, sent, dir } = makeDeck({ failWith: new Error('no herdr server is running') });
  appear(deck, 'm1', MUTE_ACTION, 3, 2);
  await deck.refresh();
  assert.match(svgOf(lastImage(sent, 'm1')), />読み上げ</);
  await press(deck, 'm1', MUTE_ACTION);
  assert.ok(fs.existsSync(path.join(dir, 'mute')));
  assert.match(svgOf(lastImage(sent, 'm1')), />ミュート</);
  await press(deck, 'm1', MUTE_ACTION);
  assert.ok(!fs.existsSync(path.join(dir, 'mute')));
});

test('herdr errors are shown on every key and presses alert', async () => {
  const { deck, sent, calls } = makeDeck({ failWith: new Error('no herdr server is running at /x; run `herdr`') });
  layoutM18(deck);
  appear(deck, 'b1', NEXT_ACTION, 3, 1);
  await deck.refresh();
  for (const key of ['s0', 't0', 'b1']) assert.match(svgOf(lastImage(sent, key)), />未接続</);
  await press(deck, 't0', TAB_ACTION);
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 't0' });
  await press(deck, 's0', SPACE_ACTION);
  assert.deepEqual(sent.at(-1), { event: 'showAlert', context: 's0' });
  assert.deepEqual(calls.herdr, []);
});

test('a terminal that cannot be raised still counts as a jump inside herdr', async () => {
  const { deck, sent, calls } = makeDeck({ raiseFails: true });
  layoutM18(deck);
  await deck.refresh();
  await press(deck, 't1', TAB_ACTION);
  assert.deepEqual(calls.herdr, ['tab w1:t2']);
  assert.equal(sent.some((m) => m.event === 'showAlert'), false);
});

test('images are only sent when they change', async () => {
  const { deck, sent } = makeDeck({ deck: { animate: false } });
  layoutM18(deck);
  await deck.refresh();
  const before = sent.length;
  await deck.refresh();
  assert.equal(sent.length, before);
  deck.animate(); // アニメーション無しでも確認待ちの顔は点滅する
  assert.ok(sent.length - before <= 2);
});

test('LED ring follows the most urgent tab and turns off when disabled', async () => {
  const { deck, calls, setConfig, setSnapshot } = makeDeck({ deck: { ledRing: true } });
  await deck.refresh();
  deck.animate();
  deck.animate();
  assert.deepEqual([...calls.led].sort(), ['255,20,60', '70,5,16'], 'blocked pulses red');
  const noBlocked = clone(snapshot);
  noBlocked.panes = noBlocked.panes.map((p) => (p.agent_status === 'blocked' ? { ...p, agent_status: 'idle' } : p));
  setSnapshot(noBlocked);
  await deck.refresh();
  deck.animate();
  assert.equal(calls.led.at(-1), '30,220,150', 'then done is mint');
  setConfig({ ledRing: false });
  await deck.refresh();
  deck.animate();
  assert.equal(calls.led.at(-1), '0,0,0');
  assert.equal(calls.ledClosed, 1);
});

test('describeError maps herdr failures to short key messages', () => {
  assert.deepEqual(describeError(Object.assign(new Error('x'), { code: 'HERDR_NOT_FOUND' })), ['herdr が見つかりません', 'config の herdr.bin を設定', '見つからず']);
  assert.equal(describeError(new Error('no herdr server is running at /x; run `herdr` to start or attach it'))[2], '未接続');
  assert.equal(describeError(Object.assign(new Error('Command failed'), { killed: true }))[0], 'herdr 応答なし');
  assert.equal(describeError(new Error('something else'))[0], 'herdr エラー');
});

test('index.js also starts when run as a shell script (VSD Craft without built-in Node)', () => {
  const run = spawnSync('/bin/sh', [path.join(PLUGIN, 'index.js')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node index\.js/);
  assert.ok(fs.statSync(path.join(PLUGIN, 'index.js')).mode & 0o111, 'index.js is executable');
});

test('end to end: VSD Craft launches the plugin, keys render, presses drive herdr', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-'));
  const config = path.join(tmp, 'config.json');
  const herdrLog = path.join(tmp, 'herdr.log');
  fs.writeFileSync(config, JSON.stringify({ herdr: { bin: path.join(FIXTURES, 'fake-herdr.js') }, deck: { pollMs: 300, frameMs: 200 }, voice: { enabled: false } }));
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
  const herdrCalled = async (line) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (fs.existsSync(herdrLog) && fs.readFileSync(herdrLog, 'utf8').includes(line)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`herdr was not called with ${line}`);
  };

  assert.deepEqual(await waitFor(() => true, 'registration'), { event: 'registerPlugin', uuid: 'UUID-1' });
  peer.sendJson({ event: 'willAppear', action: SPACE_ACTION, context: 's0', device: 'd', payload: { coordinates: { row: 0, column: 0 }, controller: 'Keypad' } });
  peer.sendJson({ event: 'willAppear', action: SPACE_ACTION, context: 's1', device: 'd', payload: { coordinates: { row: 0, column: 1 }, controller: 'Keypad' } });
  peer.sendJson({ event: 'willAppear', action: TAB_ACTION, context: 't0', device: 'd', payload: { coordinates: { row: 1, column: 0 }, controller: 'Keypad' } });
  peer.sendJson({ event: 'willAppear', action: TAB_ACTION, context: 't1', device: 'd', payload: { coordinates: { row: 1, column: 1 }, controller: 'Keypad' } });
  await waitFor((m) => m.event === 'setImage' && m.context === 't1' && svgOf(m.payload.image).includes('DB移行'), 'the blocked tab on t1');
  peer.sendJson({ event: 'keyUp', action: TAB_ACTION, context: 't1', payload: {} });
  await herdrCalled('tab focus w1:t2');
  peer.sendJson({ event: 'keyUp', action: SPACE_ACTION, context: 's1', payload: {} });
  await herdrCalled('workspace focus w2');

  peer.close();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});
