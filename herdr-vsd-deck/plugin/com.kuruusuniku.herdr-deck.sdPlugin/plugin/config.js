'use strict';

// 設定は読み上げフックと共有する JSON ファイル1つにまとめる:
//   ~/.config/herdr-vsd-deck/config.json  (HERDR_VSD_DECK_CONFIG で上書き可)
// ファイルが無い・壊れている場合は既定値で動く。更新は mtime を見て自動で取り込む。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  herdr: {
    bin: '', // 空なら PATH と既定のインストール先を探す
    session: '', // herdr --session の名前。空なら default セッション
    socketPath: '', // HERDR_SOCKET_PATH を明示したい場合だけ
  },
  deck: {
    terminalApp: '', // 空なら herdr クライアントを動かしているターミナルを自動検出
    order: 'sticky', // sticky: 一度割り当てたキーを動かさない / priority: 確認待ち→完了→作業中→待機 の順
    animate: true,
    frameMs: 500,
    pollMs: 1000,
  },
});

function configPath(env = process.env) {
  if (env.HERDR_VSD_DECK_CONFIG) return env.HERDR_VSD_DECK_CONFIG;
  return path.join(os.homedir(), '.config', 'herdr-vsd-deck', 'config.json');
}

function merge(base, override) {
  const out = { ...base };
  if (!override || typeof override !== 'object') return out;
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = merge(base[key], value);
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalize(raw) {
  const cfg = merge(DEFAULTS, raw);
  cfg.deck.frameMs = clampNumber(cfg.deck.frameMs, 150, 5000, DEFAULTS.deck.frameMs);
  cfg.deck.pollMs = clampNumber(cfg.deck.pollMs, 300, 10000, DEFAULTS.deck.pollMs);
  if (!['sticky', 'priority'].includes(cfg.deck.order)) cfg.deck.order = DEFAULTS.deck.order;
  cfg.deck.animate = cfg.deck.animate !== false;
  for (const key of ['bin', 'session', 'socketPath']) cfg.herdr[key] = String(cfg.herdr[key] || '');
  cfg.deck.terminalApp = String(cfg.deck.terminalApp || '');
  return cfg;
}

class ConfigStore {
  constructor(file = configPath()) {
    this.file = file;
    this.mtime = null;
    this.value = normalize({});
    this.error = null;
  }

  // 変更があったときだけ読み直す。戻り値は変更の有無。
  refresh() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      if (this.mtime === null) return false;
      this.mtime = null;
      this.value = normalize({});
      this.error = null;
      return true;
    }
    if (this.mtime === stat.mtimeMs) return false;
    this.mtime = stat.mtimeMs;
    try {
      this.value = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.error = null;
    } catch (err) {
      this.value = normalize({});
      this.error = `config.json を読めません: ${err.message}`;
    }
    return true;
  }
}

module.exports = { DEFAULTS, ConfigStore, configPath, normalize };
