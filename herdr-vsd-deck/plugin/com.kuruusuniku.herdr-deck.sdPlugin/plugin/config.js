'use strict';

// 設定は JSON ファイル1つにまとめる:
//   ~/.config/herdr-vsd-deck/config.json  (HERDR_VSD_DECK_CONFIG で上書き可)
// ファイルが無い・壊れている場合は既定値で動く。更新は mtime を見て自動で取り込む (再起動不要)。

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
    animate: true,
    frameMs: 300, // キャラクターのコマ送り間隔。記事は 150ms。M18 で重ければ大きく
    pollMs: 1200, // herdr に状態を聞きに行く間隔 (記事と同じ 1.2 秒)
    ledRing: false, // VSD M18 の RGB ライトを状態色にする (実験的。node-hid が必要)
  },
  voice: {
    enabled: true,
    source: 'deck', // deck: プラグインが herdr の画面を読んで読み上げる (記事の方式) / hooks: Claude Code のフックで読み上げる
    llmUrl: 'http://127.0.0.1:11434/v1', // OpenAI 互換の Chat Completions (Ollama なら /v1)
    llmModel: 'qwen3.5:9b',
    llmApiKey: '',
    voicevoxUrl: 'http://127.0.0.1:50021',
    speaker: 3, // ずんだもん (ノーマル)
    speedScale: 1.1,
    maxChars: 120,
  },
});

function configPath(env = process.env) {
  if (env.HERDR_VSD_DECK_CONFIG) return env.HERDR_VSD_DECK_CONFIG;
  return path.join(os.homedir(), '.config', 'herdr-vsd-deck', 'config.json');
}

// 読み上げのミュート状態。ファイルがあればミュート (プラグインのボタンとフックで共有)
function mutePath(env = process.env) {
  return path.join(path.dirname(configPath(env)), 'mute');
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
  const cfg = merge(structuredClone(DEFAULTS), raw); // 既定値オブジェクトを共有・変更しない
  cfg.deck.frameMs = clampNumber(cfg.deck.frameMs, 150, 5000, DEFAULTS.deck.frameMs);
  cfg.deck.pollMs = clampNumber(cfg.deck.pollMs, 300, 10000, DEFAULTS.deck.pollMs);
  cfg.deck.animate = cfg.deck.animate !== false;
  cfg.deck.ledRing = cfg.deck.ledRing === true;
  for (const key of ['bin', 'session', 'socketPath']) cfg.herdr[key] = String(cfg.herdr[key] || '');
  cfg.deck.terminalApp = String(cfg.deck.terminalApp || '');
  cfg.voice.enabled = cfg.voice.enabled !== false;
  if (!['deck', 'hooks'].includes(cfg.voice.source)) cfg.voice.source = DEFAULTS.voice.source;
  for (const key of ['llmUrl', 'llmModel', 'llmApiKey', 'voicevoxUrl']) cfg.voice[key] = String(cfg.voice[key] ?? DEFAULTS.voice[key]);
  cfg.voice.speaker = clampNumber(cfg.voice.speaker, 0, 10000, DEFAULTS.voice.speaker);
  cfg.voice.speedScale = clampNumber(cfg.voice.speedScale, 0.5, 2, DEFAULTS.voice.speedScale);
  cfg.voice.maxChars = clampNumber(cfg.voice.maxChars, 30, 400, DEFAULTS.voice.maxChars);
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

module.exports = { DEFAULTS, ConfigStore, configPath, mutePath, normalize };
