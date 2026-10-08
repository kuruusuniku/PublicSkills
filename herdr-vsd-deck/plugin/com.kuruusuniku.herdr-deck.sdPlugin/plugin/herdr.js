'use strict';

// herdr とのやり取りはすべて CLI 経由で行う (Unix ソケット / Windows 名前付きパイプの差を CLI が吸収する)。
//   状態取得:     herdr api snapshot                → スペース・タブ・ペインと各ペインの agent_status
//   切り替え:     herdr workspace focus <id> / herdr tab focus <tab_id>   (完了は既読になって待機へ)
//   画面の読取り: herdr pane read <pane_id> --source recent-unwrapped --lines 200 --format text

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// agent_status のうちエージェントがいるもの。unknown などそれ以外は「エージェントなし」として扱う
const SEVERITY = { blocked: 4, working: 3, done: 2, idle: 1 };

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

function parseJson(text) {
  try {
    return JSON.parse(text.trim().split('\n').filter(Boolean).pop() || '');
  } catch {
    return null;
  }
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
          reject(Object.assign(new Error(detail), { code: err.code || 'HERDR_FAILED', killed: err.killed }));
          return;
        }
        resolve(String(stdout));
      });
    });
  }

  async snapshot() {
    const snapshot = parseJson(await this.run(['api', 'snapshot']))?.result?.snapshot;
    if (!snapshot) throw new Error('herdr api snapshot の応答を解釈できません');
    return snapshot;
  }

  focusWorkspace(workspaceId) {
    return this.run(['workspace', 'focus', workspaceId]);
  }

  focusTab(tabId) {
    return this.run(['tab', 'focus', tabId]);
  }

  readPane(paneId, lines = 200) {
    return this.run(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text'], 8000);
  }
}

function statusOf(raw) {
  return SEVERITY[raw] ? raw : 'none';
}

// いちばん深刻な状態 (確認待ち > 作業中 > 完了 > 待機)。エージェントがいなければ none
function worst(statuses) {
  let best = 'none';
  for (const s of statuses) if (SEVERITY[s] && (best === 'none' || SEVERITY[s] > SEVERITY[best])) best = s;
  return best;
}

function byNumber(a, b) {
  return (a.number ?? Infinity) - (b.number ?? Infinity);
}

// snapshot を スペース → タブ → ペイン の木にする。並びは herdr の表示順。
function buildModel(snapshot) {
  const panesByTab = new Map();
  const panes = (snapshot.panes || []).map((p) => ({
    paneId: p.pane_id,
    tabId: p.tab_id,
    workspaceId: p.workspace_id,
    status: statusOf(p.agent_status),
    agent: p.agent || null,
    focused: Boolean(p.focused),
  }));
  for (const p of panes) {
    if (!panesByTab.has(p.tabId)) panesByTab.set(p.tabId, []);
    panesByTab.get(p.tabId).push(p);
  }

  const tabsBySpace = new Map();
  for (const t of [...(snapshot.tabs || [])].sort(byNumber)) {
    const tabPanes = panesByTab.get(t.tab_id) || [];
    const tab = {
      id: t.tab_id,
      workspaceId: t.workspace_id,
      label: t.label || String(t.number ?? ''),
      number: t.number,
      panes: tabPanes,
      status: worst(tabPanes.map((p) => p.status)),
    };
    if (!tabsBySpace.has(t.workspace_id)) tabsBySpace.set(t.workspace_id, []);
    tabsBySpace.get(t.workspace_id).push(tab);
  }

  const spaces = [...(snapshot.workspaces || [])].sort(byNumber).map((w) => {
    const tabs = tabsBySpace.get(w.workspace_id) || [];
    for (const tab of tabs) tab.spaceLabel = w.label;
    return {
      id: w.workspace_id,
      label: w.label || String(w.number ?? ''),
      number: w.number,
      activeTabId: w.active_tab_id || null,
      tabs,
      status: worst(tabs.map((t) => t.status)),
    };
  });

  return {
    spaces,
    tabs: spaces.flatMap((s) => s.tabs),
    panes,
    focusedWorkspaceId: snapshot.focused_workspace_id || null,
    focusedTabId: snapshot.focused_tab_id || null,
  };
}

const URGENT_ORDER = ['blocked', 'done', 'working'];

// サマリーで押したときに飛ぶ先: 確認待ち → 完了(未読) → 作業中 の順で最初のタブ
function mostUrgent(tabs) {
  for (const status of URGENT_ORDER) {
    const hit = tabs.find((t) => t.status === status);
    if (hit) return hit;
  }
  return null;
}

// 「次へ」の巡回順: 確認待ち → 完了 → 作業中 → 待機 (同じ状態の中は herdr の並び)。エージェントのいないタブは除く
function urgencyOrder(tabs) {
  const rank = { blocked: 0, done: 1, working: 2, idle: 3 };
  return tabs.filter((t) => t.status !== 'none').map((t, i) => [t, i])
    .sort(([a, i], [b, j]) => rank[a.status] - rank[b.status] || i - j)
    .map(([t]) => t);
}

function countByStatus(tabs) {
  const counts = { blocked: 0, working: 0, done: 0, idle: 0, none: 0 };
  for (const t of tabs) counts[t.status] += 1;
  return counts;
}

module.exports = {
  HerdrCli, buildModel, mostUrgent, urgencyOrder, countByStatus, worst, herdrCandidates, resolveHerdrBin, parseJson, SEVERITY,
};
