'use strict';

// herdr.js / config.js / focus.js / render.js / sprites.js の単体テスト

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { HerdrCli, buildModel, mostUrgent, urgencyOrder, countByStatus, worst, resolveHerdrBin } = require(path.join(PLUGIN, 'herdr.js'));
const { ConfigStore, normalize } = require(path.join(PLUGIN, 'config.js'));
const { findAppBundle, windowsScript, encodePowerShell } = require(path.join(PLUGIN, 'focus.js'));
const { renderTab, renderSpace, renderSummary, renderError, renderNext, renderMute, layoutName, STATE } = require(path.join(PLUGIN, 'render.js'));
const { frameFor, faceFor, toRects, FRAMES, CHAR_W, CHAR_H } = require(path.join(PLUGIN, 'sprites.js'));

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_HERDR = path.join(FIXTURES, 'fake-herdr.js');
const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot.json'), 'utf8')).result.snapshot;
const svgOf = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
const bgOf = (uri) => svgOf(uri).match(/<rect width="64" height="64" rx="5" fill="([^"]+)"/)?.[1];

test('buildModel nests spaces > tabs > panes in herdr order', () => {
  const model = buildModel(snapshot);
  assert.deepEqual(model.spaces.map((s) => s.label), ['業務自動化', 'herdr-streamdeck', '執筆作業']);
  assert.deepEqual(model.spaces[0].tabs.map((t) => t.label), ['工数入力', 'DB移行', '手順書', 'console', '調査']);
  assert.equal(model.spaces[0].activeTabId, 'w1:t1');
  assert.equal(model.focusedWorkspaceId, 'w1');
  assert.equal(model.focusedTabId, 'w1:t1');
  assert.equal(model.tabs.length, 7);
  assert.equal(model.panes.length, 8);
  assert.equal(model.tabs[1].spaceLabel, '業務自動化');
});

test('a tab shows its most serious pane, a space its most serious tab', () => {
  const model = buildModel(snapshot);
  const [work, herdrSpace, writing] = model.spaces;
  assert.deepEqual(work.tabs.map((t) => t.status), ['working', 'blocked', 'done', 'none', 'idle']);
  assert.equal(work.status, 'blocked');
  assert.equal(herdrSpace.status, 'idle');
  assert.equal(writing.status, 'none', 'unknown means no agent');
  assert.equal(worst(['idle', 'done', 'working']), 'working');
  assert.equal(worst(['unknown', 'idle']), 'idle');
  assert.equal(worst([]), 'none');
});

test('urgency helpers pick blocked, then done, then working', () => {
  const { tabs } = buildModel(snapshot);
  assert.equal(mostUrgent(tabs).id, 'w1:t2');
  assert.equal(mostUrgent(tabs.filter((t) => t.status !== 'blocked')).id, 'w1:t3');
  assert.equal(mostUrgent(tabs.filter((t) => ['idle', 'none'].includes(t.status))), null);
  assert.deepEqual(urgencyOrder(tabs).map((t) => t.id), ['w1:t2', 'w1:t3', 'w1:t1', 'w1:t5', 'w2:t1']);
  assert.deepEqual(countByStatus(tabs), { blocked: 1, working: 1, done: 1, idle: 2, none: 2 });
});

test('resolveHerdrBin searches installer locations when PATH is minimal', () => {
  const home = '/Users/me';
  const found = resolveHerdrBin('', { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home, exists: (p) => p === '/Users/me/.local/bin/herdr' });
  assert.equal(found, '/Users/me/.local/bin/herdr');
  assert.equal(resolveHerdrBin('', { platform: 'darwin', env: { PATH: '' }, home, exists: (p) => p === '/opt/homebrew/bin/herdr' }), '/opt/homebrew/bin/herdr');
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
    assert.equal((await cli.snapshot()).workspaces.length, 3);
    assert.match(await cli.readPane('w1:p2'), /screen of w1:p2/);
    process.env.FAKE_HERDR_SNAPSHOT = '/nonexistent.json';
    await assert.rejects(cli.snapshot(), /no herdr server is running/);
    const missing = new HerdrCli({}, { resolve: () => null });
    await assert.rejects(missing.snapshot(), (err) => err.code === 'HERDR_NOT_FOUND');
  } finally {
    if (saved === undefined) delete process.env.FAKE_HERDR_SNAPSHOT;
    else process.env.FAKE_HERDR_SNAPSHOT = saved;
  }
});

test('HerdrCli sends the documented commands with session overrides', async () => {
  const seen = [];
  const cli = new HerdrCli({ bin: 'herdr', session: 'work', socketPath: '/tmp/h.sock' }, {
    execFile: (bin, args, opts, cb) => { seen.push({ args, env: opts.env }); cb(null, '{"result":{"type":"ok"}}', ''); },
  });
  await cli.focusTab('w1:t2');
  await cli.focusWorkspace('w2');
  await cli.readPane('w1:p2');
  assert.deepEqual(seen.map((s) => s.args), [
    ['tab', 'focus', 'w1:t2'],
    ['workspace', 'focus', 'w2'],
    ['pane', 'read', 'w1:p2', '--source', 'recent-unwrapped', '--lines', '200', '--format', 'text'],
  ]);
  assert.equal(seen[0].env.HERDR_SESSION, 'work');
  assert.equal(seen[0].env.HERDR_SOCKET_PATH, '/tmp/h.sock');
});

test('config falls back to defaults and reloads on change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
  const file = path.join(dir, 'config.json');
  const store = new ConfigStore(file);
  assert.equal(store.refresh(), false);
  assert.equal(store.value.deck.pollMs, 1200);
  assert.equal(store.value.voice.llmModel, 'qwen3.5:9b');
  assert.equal(store.value.voice.llmUrl, 'http://127.0.0.1:11434/v1');
  fs.writeFileSync(file, JSON.stringify({ deck: { pollMs: 50, terminalApp: 'Ghostty' }, voice: { speaker: '1', source: 'nope' } }));
  assert.equal(store.refresh(), true);
  assert.equal(store.value.deck.pollMs, 300, 'clamped to the minimum');
  assert.equal(store.value.deck.terminalApp, 'Ghostty');
  assert.equal(store.value.voice.speaker, 1);
  assert.equal(store.value.voice.source, 'deck');
  fs.writeFileSync(file, '{ broken');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(store.refresh(), true);
  assert.match(store.error, /config\.json/);
  assert.equal(normalize({}).deck.frameMs, 300);
  normalize({ deck: { frameMs: 999 } });
  assert.equal(normalize({}).deck.frameMs, 300, 'defaults are never mutated');
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
  const iterm = [
    '  20     1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
    '  30     1 /Users/me/Library/Application Support/iTerm2/iTermServer-3.5.0',
    '  31    30 /usr/bin/login',
    '  32    31 -zsh',
    '  33    32 herdr',
  ].join('\n');
  assert.equal(findAppBundle(iterm), 'iTerm');
  const tmux = ['  40     1 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui', '  50     1 tmux', '  51    50 -zsh', '  52    51 herdr'].join('\n');
  assert.equal(findAppBundle(tmux), 'WezTerm', 'falls back to a running known terminal');
  assert.equal(findAppBundle('  500     1 /Users/me/.local/bin/herdr'), null);
});

test('windowsScript escapes the preferred process name and is passed encoded', () => {
  assert.match(windowsScript("Wez'Term.exe"), /\$prefer = 'Wez''Term'/);
  assert.equal(Buffer.from(encodePowerShell('Write-Output "日本語"'), 'base64').toString('utf16le'), 'Write-Output "日本語"');
});

test('names: four full-width characters fit one line, longer ones shrink or wrap to two', () => {
  assert.deepEqual(layoutName('調査'), [{ text: '調査', size: 14 }]);
  assert.deepEqual(layoutName('業務自動化').length, 1, 'slightly too long: shrink');
  assert.ok(layoutName('業務自動化')[0].size < 14);
  assert.deepEqual(layoutName('herdr-deck').length, 1, 'a word a little too long shrinks');
  assert.deepEqual(layoutName('herdr-streamdeck').map((l) => l.text), ['herdr-', 'stream…'], 'a long word wraps after the hyphen');
  assert.deepEqual(layoutName('hello server').map((l) => l.text), ['hello', 'server']);
  const long = layoutName('とても長いタブの名前ですよ');
  assert.equal(long.length, 2);
  assert.ok(long[1].text.endsWith('…') || long[1].text.length <= 4);
});

test('tab keys use the article colours and pale backgrounds when selected', () => {
  const tab = (status) => ({ label: 'API修正', status });
  for (const status of ['blocked', 'working', 'done', 'idle', 'none']) {
    assert.equal(bgOf(renderTab(tab(status))), STATE[status].dark);
    assert.equal(bgOf(renderTab(tab(status), { selected: true })), STATE[status].pale);
  }
  const plain = svgOf(renderTab(tab('working')));
  const chosen = svgOf(renderTab(tab('working'), { selected: true }));
  assert.match(plain, /fill="#ffffff">API修正</);
  assert.match(plain, /fill-opacity="0.45">API修正</, 'white text with a soft shadow');
  assert.match(chosen, /fill="#1e1b4b">API修正</, 'navy text when selected');
  assert.match(plain, /^<svg [^>]*width="128" height="128" viewBox="0 0 64 64"/);
  assert.notEqual(renderTab(tab('blocked'), { tick: 0 }), renderTab(tab('blocked'), { tick: 1 }), 'residents animate');
  assert.equal(renderTab(tab('blocked'), { tick: 0, animate: false }), renderTab(tab('blocked'), { tick: 1, animate: false }));
  assert.equal(bgOf(renderTab(null)), '#0d0b14', 'empty slot');
});

test('space keys show the residents faces and the tab page', () => {
  const { spaces } = buildModel(snapshot);
  const svg = svgOf(renderSpace(spaces[0], { selected: true, page: 1, pages: 2 }));
  assert.match(svg, />2\/2</);
  assert.match(svg, />\+2</, 'four residents but only room for three faces next to the page counter');
  assert.equal(bgOf(renderSpace(spaces[0])), STATE.blocked.dark);
  assert.equal(bgOf(renderSpace(spaces[2])), STATE.none.dark);
  assert.doesNotMatch(svgOf(renderSpace(spaces[0])), /\/2</, 'page counter only on the selected space');
});

test('rendered text is XML-escaped', () => {
  const svg = svgOf(renderTab({ label: '<b>&"x"', status: 'idle' }));
  assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;/);
  assert.doesNotMatch(svg, /<b>/);
});

test('summary, error and button icons render', () => {
  const summary = svgOf(renderSummary({ blocked: 0, working: 120, done: 3, idle: 1, none: 4 }));
  assert.match(summary, />99</, 'large counts are capped to fit');
  assert.match(svgOf(renderError('herdr 未接続', 'x', '未接続')), />未接続</);
  assert.match(svgOf(renderNext(12)), />9\+</);
  assert.match(svgOf(renderMute(true)), />ミュート</);
  assert.match(svgOf(renderMute(false)), />読み上げ</);
});

test('every resident frame stays inside its 14x12 grid and animates', () => {
  for (const status of Object.keys(FRAMES)) {
    for (const tick of [0, 1]) {
      const pixels = frameFor(status, tick);
      assert.ok(pixels.length > 20, `${status} draws something`);
      for (const p of pixels) assert.ok(p.x >= 0 && p.x < CHAR_W && p.y >= 0 && p.y < CHAR_H, `${status}/${tick} pixel ${p.x},${p.y}`);
      assert.ok(toRects(pixels).length < pixels.length, 'runs are merged');
    }
    if (status !== 'none') assert.notDeepEqual(frameFor(status, 0), frameFor(status, 1), `${status} animates`);
  }
  assert.notDeepEqual(faceFor('blocked', 0), faceFor('blocked', 1), 'a waiting face blinks');
});
