'use strict';

// herdr とのやり取りはすべて CLI 経由で行う (Unix ソケット / Windows 名前付きパイプの差を CLI が吸収する)。
//   状態取得:   herdr api snapshot          → session.snapshot の JSON
//   ジャンプ:   herdr agent focus <pane_id> → herdr 内でそのペインへ移動し「完了」を既読にする

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
// Claude Code が端末タイトルを付ける前の既定値。タスク名としては意味が無いので表示しない。
const GENERIC_TITLES = new Set(['claude', 'claude code', 'codex', 'herdr', '']);

// VSD Craft は GUI アプリなので PATH が最小限になる。herdr の各インストーラの置き場所も探す。
function herdrCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      ...pathDirs.map((dir) => path.join(dir, 'herdr.exe')),
      path.join(local, 'Programs', 'Herdr', 'bin', 'herdr.exe'),
    ];
  }
  return [
    ...pathDirs.map((dir) => path.join(dir, 'herdr')),
    path.join(home, '.local', 'bin', 'herdr'),
    '/opt/homebrew/bin/herdr',
    '/usr/local/bin/herdr',
    path.join(home, '.cargo', 'bin', 'herdr'),
    path.join(home, '.local', 'share', 'mise', 'shims', 'herdr'),
    '/usr/bin/herdr',
  ];
}

function resolveHerdrBin(configured, { platform, env, home, exists = fs.existsSync } = {}) {
  if (configured) return configured;
  return herdrCandidates(platform, env, home).find((candidate) => exists(candidate)) || null;
}

class HerdrCli {
  constructor({ bin = '', session = '', socketPath = '' } = {}, deps = {}) {
    this.configured = bin;
    this.session = session;
    this.socketPath = socketPath;
    this.execFile = deps.execFile || execFile;
    this.resolve = deps.resolve || resolveHerdrBin;
    this.bin = null;
  }

  env() {
    const env = { ...process.env };
    if (this.session) env.HERDR_SESSION = this.session;
    if (this.socketPath) env.HERDR_SOCKET_PATH = this.socketPath;
    return env;
  }

  run(args, timeoutMs = 4000) {
    if (!this.bin) this.bin = this.resolve(this.configured);
    if (!this.bin) return Promise.reject(Object.assign(new Error('herdr コマンドが見つかりません'), { code: 'HERDR_NOT_FOUND' }));
    return new Promise((resolve, reject) => {
      this.execFile(this.bin, args, { env: this.env(), timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') this.bin = null; // 次回また探す
          const detail = parseJson(String(stderr || ''))?.error?.message || String(stderr || '').trim() || err.message;
          reject(Object.assign(new Error(detail), { code: err.code || 'HERDR_FAILED' }));
          return;
        }
        resolve(String(stdout));
      });
    });
  }

  async snapshot() {
    const out = await this.run(['api', 'snapshot']);
    const response = parseJson(out);
    const snapshot = response?.result?.snapshot;
    if (!snapshot) throw new Error('herdr api snapshot の応答を解釈できません');
    return snapshot;
  }

  focusAgent(paneId) {
    return this.run(['agent', 'focus', paneId]);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text.trim().split('\n').filter(Boolean).pop() || '');
  } catch {
    return null;
  }
}

function basename(p) {
  if (!p) return '';
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

// snapshot をキー表示用の平たいリストにする。並びは herdr の UI と同じ (ワークスペース→タブ→ペイン)。
function buildAgents(snapshot) {
  const workspaces = new Map((snapshot.workspaces || []).map((w) => [w.workspace_id, w]));
  const tabs = new Map((snapshot.tabs || []).map((t) => [t.tab_id, t]));
  const paneOrder = new Map((snapshot.panes || []).map((p, i) => [p.pane_id, i]));

  const agents = (snapshot.agents || []).map((a, index) => {
    const ws = workspaces.get(a.workspace_id);
    const tab = tabs.get(a.tab_id);
    const status = STATUSES.has(a.agent_status) ? a.agent_status : 'unknown';
    const titleCandidates = [a.title, a.terminal_title_stripped];
    const task = titleCandidates.map((t) => String(t || '').trim()).find((t) => !GENERIC_TITLES.has(t.toLowerCase())) || '';
    return {
      id: a.terminal_id || a.pane_id, // ペイン移動で pane_id は変わるが terminal_id は変わらない
      paneId: a.pane_id,
      workspaceId: a.workspace_id,
      tabId: a.tab_id,
      status,
      kind: a.display_agent || a.agent || 'agent',
      name: a.name || '',
      workspace: ws?.label || basename(a.foreground_cwd || a.cwd) || a.workspace_id,
      tab: tab?.label || '',
      task,
      project: basename(a.foreground_cwd || a.cwd),
      focused: Boolean(a.focused),
      order: [ws?.number ?? Number.MAX_SAFE_INTEGER, tab?.number ?? Number.MAX_SAFE_INTEGER, paneOrder.get(a.pane_id) ?? index],
    };
  });

  agents.sort((x, y) => x.order[0] - y.order[0] || x.order[1] - y.order[1] || x.order[2] - y.order[2]);
  return agents;
}

const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

// サマリーキーで押したときに飛ぶ先: 確認待ち → 完了(未読) → 作業中 の順。
function mostUrgent(agents) {
  return [...agents]
    .filter((a) => a.status !== 'idle' && a.status !== 'unknown')
    .sort((x, y) => URGENCY[x.status] - URGENCY[y.status])[0] || null;
}

function countByStatus(agents) {
  const counts = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
  for (const a of agents) counts[a.status] += 1;
  return counts;
}

module.exports = { HerdrCli, buildAgents, mostUrgent, countByStatus, herdrCandidates, resolveHerdrBin, parseJson, URGENCY };
