'use strict';

// voice.js (プラグイン側のずんだもん読み上げ) のテスト。LLM・VOICEVOX・herdr・スピーカーは偽物。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { Voice, detectEvents, sanitize, playerCommand, QUEUE_MAX } = require(path.join(PLUGIN, 'voice.js'));
const { buildModel } = require(path.join(PLUGIN, 'herdr.js'));
const { normalize } = require(path.join(PLUGIN, 'config.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot.json'), 'utf8')).result.snapshot;
const SCREEN = fs.readFileSync(path.join(FIXTURES, 'screen.txt'), 'utf8');
const WAV = Buffer.from('RIFF....WAVEfmt fake');
const REPLY = 'テストを直すために依存パッケージを入れ直す途中なのだ。フォルダを削除して入れ直すコマンドの許可を求めているのだ。許可する、今後も許可する、やめる、のどれかを選んでほしいのだ。';

function fakeFetch({ down = [], reply = REPLY } = {}) {
  const requests = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null, method: opts.method || 'GET' });
    if (down.some((d) => u.pathname.endsWith(d))) throw new Error('ECONNREFUSED');
    if (u.pathname === '/version') return new Response('"0.99"');
    if (u.pathname === '/v1/models') return new Response('{"data":[]}');
    if (u.pathname === '/v1/chat/completions') return Response.json({ choices: [{ message: { content: reply } }] });
    if (u.pathname === '/audio_query') return Response.json({ accent_phrases: [], speedScale: 1 });
    if (u.pathname === '/synthesis') return new Response(WAV);
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, requests };
}

function makeVoice({ voice = {}, fetchOpts = {}, screens = [SCREEN], muted = false } = {}) {
  const cfg = normalize({ voice }).voice;
  const { fetchImpl, requests } = fakeFetch(fetchOpts);
  const played = [];
  const reads = [];
  const logs = [];
  let n = 0;
  const herdr = {
    readPane: async (paneId, lines) => {
      reads.push([paneId, lines]);
      const next = screens[Math.min(n, screens.length - 1)];
      n += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const v = new Voice({ config: () => cfg, herdr: () => herdr, log: (l) => logs.push(l), isMuted: () => muted, fetchImpl, play: async (wav) => { played.push(wav); }, retryMs: 0 });
  return { v, requests, played, reads, logs };
}

const withPane = (paneId, status) => {
  const s = JSON.parse(JSON.stringify(snapshot));
  s.panes = s.panes.map((p) => (p.pane_id === paneId ? { ...p, agent_status: status } : p));
  return buildModel(s);
};

test('only real transitions trigger a reading', () => {
  const prev = new Map([['a', 'working'], ['b', 'working'], ['c', 'done'], ['d', 'idle'], ['e', 'blocked']]);
  const panes = [
    { paneId: 'a', status: 'done' }, // 作業が終わった
    { paneId: 'b', status: 'idle' }, // 見ているタブの作業が終わると done を経由せず idle
    { paneId: 'c', status: 'idle' }, // 見ただけ
    { paneId: 'd', status: 'blocked' }, // 確認待ち
    { paneId: 'e', status: 'blocked' }, // 変わっていない
    { paneId: 'f', status: 'blocked' }, // 初めて見るペイン
  ];
  assert.deepEqual(detectEvents(prev, panes), [
    { paneId: 'a', kind: 'finished' }, { paneId: 'b', kind: 'finished' }, { paneId: 'd', kind: 'waiting' },
  ]);
});

test('nothing is read right after start, then a transition is announced with the space name', async () => {
  const { v, requests, played, reads } = makeVoice();
  assert.deepEqual(v.observe(buildModel(snapshot)), [], 'no previous state at start');
  const events = v.observe(withPane('w1:p1', 'done'));
  assert.deepEqual(events, [{ paneId: 'w1:p1', kind: 'finished' }]);
  await v.busy;
  assert.deepEqual(reads, [['w1:p1', 200]]);
  assert.equal(played.length, 1);
  assert.deepEqual(played[0], WAV);
  const chat = requests.find((r) => r.path === '/v1/chat/completions').body;
  assert.equal(chat.model, 'qwen3.5:9b');
  assert.equal(chat.reasoning_effort, 'none');
  assert.match(chat.messages[0].content, /ずんだもん/);
  assert.match(chat.messages[0].content, /❯ で始まる行がユーザーの依頼/);
  assert.match(chat.messages[1].content, /状況: 作業が終わった/);
  assert.match(chat.messages[1].content, /Do you want to proceed\?/);
  const query = requests.find((r) => r.path === '/audio_query').query;
  assert.equal(query.speaker, '3');
  assert.ok(query.text.startsWith('業務自動化から。'), query.text);
});

test('announce returns the full sentence and skips a screen it already read', async () => {
  const { v, played } = makeVoice();
  const first = await v.announce({ paneId: 'w1:p2', kind: 'waiting', space: '業務自動化' });
  assert.equal(first, `業務自動化から。${REPLY}`);
  assert.equal(await v.announce({ paneId: 'w1:p2', kind: 'waiting', space: '業務自動化' }), null, 'same screen is not read twice');
  assert.equal(played.length, 1);
});

test('when VOICEVOX or the LLM is not running the reading is skipped silently', async () => {
  for (const down of ['/version', '/models']) {
    const { v, played, reads, logs } = makeVoice({ fetchOpts: { down: [down] } });
    assert.equal(await v.announce({ paneId: 'w1:p2', kind: 'waiting', space: 'x' }), null);
    assert.equal(played.length, 0);
    assert.equal(reads.length, 0, 'does not even read the screen');
    assert.match(logs.at(-1), /応答しない/);
  }
});

test('muted, disabled, or hook mode: the deck stays quiet', async () => {
  const muted = makeVoice({ muted: true });
  assert.equal(await muted.v.announce({ paneId: 'w1:p2', kind: 'waiting', space: 'x' }), null);
  assert.equal(muted.requests.length, 0);
  for (const voice of [{ enabled: false }, { source: 'hooks' }]) {
    const { v, reads } = makeVoice({ voice });
    v.observe(buildModel(snapshot));
    v.observe(withPane('w1:p1', 'done'));
    await v.busy;
    assert.equal(reads.length, 0);
  }
});

test('the screen is retried up to three times', async () => {
  const { v, reads, played } = makeVoice({ screens: [new Error('not ready'), '', SCREEN] });
  await v.announce({ paneId: 'w1:p4', kind: 'finished', space: 'x' });
  assert.equal(reads.length, 3);
  assert.equal(played.length, 1);
  const failing = makeVoice({ screens: [new Error('gone')] });
  await assert.rejects(failing.v.announce({ paneId: 'w1:p4', kind: 'finished', space: 'x' }), /gone/);
  assert.equal(failing.reads.length, 3);
});

test('readings queue one at a time and drop the oldest beyond three', async () => {
  const { v, reads } = makeVoice({ screens: ['a', 'b', 'c', 'd', 'e', 'f'] });
  for (const paneId of ['p1', 'p2', 'p3', 'p4', 'p5']) v.enqueue({ paneId, kind: 'finished', space: 'x' });
  await v.busy;
  // p1 は即座に読み始め、残り 4 件のうち古い p2 が捨てられる
  assert.deepEqual(reads.map(([p]) => p), ['p1', 'p3', 'p4', 'p5']);
  assert.equal(QUEUE_MAX, 3);
});

test('LLM output is cleaned for speech', () => {
  assert.equal(sanitize('<think>考え中</think>\n**直した**のだ。\n`npm test` も通ったのだ。'), '直したのだ。npm test も通ったのだ。');
  assert.equal(sanitize(`${'あ'.repeat(30)}のだ。${'い'.repeat(200)}`, 120), `${'あ'.repeat(30)}のだ。`);
});

test('a player is chosen per platform', () => {
  assert.deepEqual(playerCommand('/tmp/x.wav', 'darwin'), ['afplay', ['/tmp/x.wav']]);
  const [cmd, args] = playerCommand("C:\\Temp\\it's.wav", 'win32');
  assert.equal(cmd, 'powershell.exe');
  assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /SoundPlayer 'C:\\Temp\\it''s\.wav'/);
});
