'use strict';

// herdr.js / slots.js / config.js / focus.js / render.js の単体テスト

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { HerdrCli, buildAgents, mostUrgent, countByStatus, resolveHerdrBin } = require(path.join(PLUGIN, 'herdr.js'));
const { SlotBook, orderKeys } = require(path.join(PLUGIN, 'slots.js'));
const { ConfigStore, normalize } = require(path.join(PLUGIN, 'config.js'));
const { findAppBundle, windowsScript, encodePowerShell } = require(path.join(PLUGIN, 'focus.js'));
const { renderAgent, renderSummary, renderError, compactAgent, compactSummary, compactError, renderNext, renderMute, fit, formatAge } = require(path.join(PLUGIN, 'render.js'));
const { frameFor, toRects, FRAMES } = require(path.join(PLUGIN, 'sprites.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_HERDR = path.join(FIXTURES, 'fake-herdr.js');
const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot.json'), 'utf8')).result.snapshot;
const svgOf = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));

test('buildAgents orders like the herdr UI and picks readable labels', () => {
  const agents = buildAgents(snapshot);
  assert.deepEqual(agents.map((a) => a.paneId), ['w1:p1', 'w1:p2', 'w2:p1']);
  assert.deepEqual(agents.map((a) => a.status), ['working', 'blocked', 'done']);
  assert.equal(agents[0].workspace, 'api');
  assert.equal(agents[0].task, 'Refactor auth');
  assert.equal(agents[1].name, 'reviewer');
  assert.equal(agents[1].task, '', 'generic "Codex" title is not a task');
  assert.equal(agents[2].workspace, 'フロント');
  assert.equal(agents[2].id, 'term_c');
});

test('mostUrgent prefers blocked, then done, then working', () => {
  const agents = buildAgents(snapshot);
  assert.equal(mostUrgent(agents).paneId, 'w1:p2');
  assert.equal(mostUrgent(agents.filter((a) => a.status !== 'blocked')).paneId, 'w2:p1');
  assert.equal(mostUrgent(agents.map((a) => ({ ...a, status: 'idle' }))), null);
  assert.deepEqual(countByStatus(agents), { blocked: 1, working: 1, done: 1, idle: 0, unknown: 0 });
});

test('SlotBook keeps slots sticky and reuses gaps', () => {
  const book = new SlotBook();
  const a = { id: 'a', status: 'working' };
  const b = { id: 'b', status: 'idle' };
  const c = { id: 'c', status: 'blocked' };
  book.update([a, b, c], 1000);
  assert.deepEqual(book.layout([a, b, c]).map((x) => x?.id), ['a', 'b', 'c']);
  book.update([a, c], 2000); // b が終了 → 1番は空く
  const layout = book.layout([a, c]);
  assert.equal(layout[1], undefined);
  assert.equal(layout[2].id, 'c');
  const d = { id: 'd', status: 'working' };
  book.update([a, c, d], 3000); // 新顔は空いた1番へ
  assert.deepEqual(book.layout([a, c, d]).map((x) => x?.id), ['a', 'd', 'c']);
  assert.deepEqual(book.layout([a, c, d], 'priority').map((x) => x.id), ['c', 'a', 'd']);
});

test('SlotBook tracks how long each agent has been in its status', () => {
  const book = new SlotBook();
  book.update([{ id: 'a', status: 'working' }], 1000);
  book.update([{ id: 'a', status: 'working' }], 5000);
  assert.equal(book.statusSince('a'), 1000);
  book.update([{ id: 'a', status: 'done' }], 9000);
  assert.equal(book.statusSince('a'), 9000);
});

test('orderKeys sorts by device, row, then column', () => {
  const keys = [
    { context: 'c', device: 'd1', row: 1, column: 0 },
    { context: 'b', device: 'd1', row: 0, column: 2 },
    { context: 'a', device: 'd1', row: 0, column: 0 },
    { context: 'z', device: 'd0', row: 2, column: 4 },
  ];
  assert.deepEqual(orderKeys(keys), ['z', 'a', 'b', 'c']);
});

test('resolveHerdrBin searches installer locations when PATH is minimal', () => {
  const home = '/Users/me';
  const found = resolveHerdrBin('', { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home, exists: (p) => p === '/Users/me/.local/bin/herdr' });
  assert.equal(found, '/Users/me/.local/bin/herdr');
  const win = resolveHerdrBin('', { platform: 'win32', env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, home, exists: (p) => p.endsWith('herdr.exe') });
  assert.match(win, /Programs[\\/]Herdr[\\/]bin[\\/]herdr\.exe$/);
  assert.equal(resolveHerdrBin('/custom/herdr', { exists: () => false }), '/custom/herdr');
  assert.equal(resolveHerdrBin('', { platform: 'linux', env: { PATH: '' }, home, exists: () => false }), null);
});

test('HerdrCli reads the snapshot and reports server errors', async () => {
  const saved = process.env.FAKE_HERDR_SNAPSHOT;
  process.env.FAKE_HERDR_SNAPSHOT = path.join(FIXTURES, 'snapshot.json');
  try {
    const cli = new HerdrCli({ bin: FAKE_HERDR });
    assert.equal((await cli.snapshot()).agents.length, 3);
    process.env.FAKE_HERDR_SNAPSHOT = '/nonexistent.json';
    await assert.rejects(cli.snapshot(), /no herdr server is running/);
    const missing = new HerdrCli({}, { resolve: () => null });
    await assert.rejects(missing.snapshot(), (err) => err.code === 'HERDR_NOT_FOUND');
  } finally {
    if (saved === undefined) delete process.env.FAKE_HERDR_SNAPSHOT;
    else process.env.FAKE_HERDR_SNAPSHOT = saved;
  }
});

test('HerdrCli passes session and socket overrides through the environment', async () => {
  let seen;
  const cli = new HerdrCli({ bin: 'herdr', session: 'work', socketPath: '/tmp/h.sock' }, {
    execFile: (bin, args, opts, cb) => { seen = { bin, args, env: opts.env }; cb(null, '{"result":{"type":"ok"}}', ''); },
  });
  await cli.focusAgent('w1:p2');
  assert.deepEqual(seen.args, ['agent', 'focus', 'w1:p2']);
  assert.equal(seen.env.HERDR_SESSION, 'work');
  assert.equal(seen.env.HERDR_SOCKET_PATH, '/tmp/h.sock');
});

test('config falls back to defaults and reloads on change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
  const file = path.join(dir, 'config.json');
  const store = new ConfigStore(file);
  assert.equal(store.refresh(), false);
  assert.equal(store.value.deck.pollMs, 1000);
  fs.writeFileSync(file, JSON.stringify({ deck: { pollMs: 50, order: 'priority', terminalApp: 'Ghostty' }, voice: { speaker: 1 } }));
  assert.equal(store.refresh(), true);
  assert.equal(store.value.deck.pollMs, 300, 'clamped to the minimum');
  assert.equal(store.value.deck.order, 'priority');
  assert.equal(store.value.deck.terminalApp, 'Ghostty');
  assert.equal(store.value.deck.frameMs, 500);
  fs.writeFileSync(file, '{ broken');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(store.refresh(), true);
  assert.match(store.error, /config\.json/);
  assert.equal(normalize({ deck: { order: 'random' } }).deck.order, 'sticky');
});

test('findAppBundle walks from the herdr client up to the terminal app', () => {
  const ps = [
    '    1     0 /sbin/launchd',
    '  400     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
    '  401   400 /usr/bin/login',
    '  402   401 -zsh',
    '  403   402 /Users/me/.local/bin/herdr',
    '  500     1 /Users/me/.local/bin/herdr',
  ].join('\n');
  assert.equal(findAppBundle(ps), '/Applications/Ghostty.app');
  const vscode = [
    '  10     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '  11    10 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    '  12    11 /bin/zsh',
    '  13    12 herdr',
  ].join('\n');
  assert.equal(findAppBundle(vscode), '/Applications/Visual Studio Code.app');
  assert.equal(findAppBundle('  500     1 /Users/me/.local/bin/herdr'), null, 'the detached server alone has no terminal');
});

test('findAppBundle handles iTerm2 and terminals it cannot trace', () => {
  const iterm = [
    '  20     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
    '  30     1 /Users/me/Library/Application Support/iTerm2/iTermServer-3.5.0',
    '  31    30 /usr/bin/login',
    '  32    31 -zsh',
    '  33    32 herdr',
  ].join('\n');
  assert.equal(findAppBundle(iterm), 'iTerm');
  const tmux = [
    '  40     1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
    '  50     1 tmux',
    '  51    50 -zsh',
    '  52    51 herdr',
  ].join('\n');
  assert.equal(findAppBundle(tmux), 'WezTerm', 'falls back to a running known terminal');
});

test('windowsScript escapes the preferred process name', () => {
  const script = windowsScript("Wez'Term.exe");
  assert.match(script, /\$prefer = 'Wez''Term'/);
  assert.match(script, /SetForegroundWindow/);
  assert.equal(Buffer.from(encodePowerShell('Write-Output "日本語"'), 'base64').toString('utf16le'), 'Write-Output "日本語"');
});

test('fit truncates by visual width', () => {
  assert.equal(fit('api', 124, 16), 'api');
  assert.equal(fit('とても長いワークスペースの名前です', 124, 16), 'とても長いワ…');
  assert.equal(fit('フロントエンド', 124, 16), 'フロントエンド');
  assert.equal(fit('infra-terraform-modules', 124, 16).endsWith('…'), true);
  assert.equal(formatAge(30 * 1000), '今');
  assert.equal(formatAge(5 * 60000), '5分');
  assert.equal(formatAge(3 * 3600000), '3時間');
  assert.equal(formatAge(49 * 3600000), '2日');
});

test('renderAgent shows status, labels and blinks when blocked', () => {
  const agents = buildAgents(snapshot);
  const blocked = agents[1];
  const f0 = svgOf(renderAgent(blocked, { agents, since: 0, now: 120000, tick: 0 }));
  const f1 = svgOf(renderAgent(blocked, { agents, since: 0, now: 120000, tick: 1 }));
  assert.match(f0, /^<svg [^>]*width="144"/);
  assert.match(f0, /<\/svg>$/);
  assert.match(f0, />確認待ち</);
  assert.match(f0, />2分</);
  assert.match(f0, />reviewer</);
  assert.notEqual(f0, f1);
  const working = svgOf(renderAgent(agents[0], { agents, tick: 0 }));
  assert.match(working, />api main</, 'two agents in one workspace are told apart by tab');
  assert.match(working, />Refactor auth</);
  const still = (t) => renderAgent(agents[0], { agents, tick: t, animate: false });
  assert.equal(still(0), still(1), 'animation can be turned off');
});

test('rendered text is XML-escaped', () => {
  const agent = { ...buildAgents(snapshot)[0], name: '<b>&"x"', task: "a'b" };
  const svg = svgOf(renderAgent(agent, { agents: [agent] }));
  assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;/);
  assert.match(svg, /a&apos;b/);
  assert.doesNotMatch(svg, /<b>/);
});

test('summary and error keys render', () => {
  const svg = svgOf(renderSummary({ blocked: 2, working: 1, done: 0, idle: 1, unknown: 1 }, { total: 5 }));
  assert.match(svg, />herdr {2}5体</);
  assert.match(svg, />2</);
  assert.match(svgOf(renderError('herdr 未接続', 'herdr を起動してください')), />herdr 未接続</);
});

test('every sprite frame stays inside the grid', () => {
  for (const status of Object.keys(FRAMES)) {
    for (const tick of [0, 1]) {
      const pixels = frameFor(status, tick);
      assert.ok(pixels.length > 50, `${status} has a sheep`);
      for (const p of pixels) {
        assert.ok(p.x >= 0 && p.x < 24 && p.y >= 0 && p.y < 16, `${status}/${tick} pixel ${p.x},${p.y} out of grid`);
      }
      const rects = toRects(pixels);
      assert.ok(rects.length < pixels.length, 'runs are merged');
    }
    assert.notDeepEqual(frameFor(status, 0), frameFor(status, 1), `${status} animates`);
  }
});

test('compact keys are 64-unit SVGs rendered at 2x with integer sprite pixels', () => {
  const agents = buildAgents(snapshot);
  const svg = svgOf(compactAgent(agents[2], { agents, since: 0, now: 3 * 60000, tick: 0 }));
  assert.match(svg, /^<svg [^>]*width="128" height="128" viewBox="0 0 64 64"/);
  assert.match(svg, />3分</);
  assert.match(svg, />フロント</);
  for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="2"/g)) {
    assert.ok([m[1], m[2], m[3]].every((v) => Number.isInteger(Number(v))), `sprite rect on whole units: ${m[0]}`);
  }
  const blink = (tick) => compactAgent(agents[1], { agents, tick });
  assert.notEqual(blink(0), blink(1), 'blocked keys blink');
  assert.match(fit('とても長いワークスペース名', 62, 12), /^とても…$|^とても長…$/);
});

test('compact summary, error and button icons render', () => {
  const summary = svgOf(compactSummary({ blocked: 0, working: 120, done: 3, idle: 1, unknown: 1 }));
  assert.match(summary, />99</, 'large counts are capped to fit');
  assert.match(summary, />2</, 'idle includes unknown');
  assert.match(svgOf(compactError('herdr 未接続', 'x', '未接続')), />未接続</);
  assert.match(svgOf(renderNext(12)), />9\+</);
  assert.doesNotMatch(svgOf(renderNext(0)), /<rect x="40"/, 'no badge when nobody waits');
  assert.match(svgOf(renderMute(true)), />ミュート</);
  assert.match(svgOf(renderMute(false)), />読み上げ</);
});
