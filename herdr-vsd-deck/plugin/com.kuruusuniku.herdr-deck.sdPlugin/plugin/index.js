'use strict';

// VSD Craft (Mirabox Stream Dock) プラグインのエントリポイント。
// VSD Craft が `node index.js -port P -pluginUUID U -registerEvent E -info JSON` で起動する。
//
//   herdr エージェント キー: 1キー=1エージェント。色とドット絵で状態を表示し、押すとそのターミナルへ移動
//   herdr サマリー キー:     確認待ち/作業中/完了/待機 の数。押すと一番急ぎのエージェントへ移動
//                           (ノブに置くと、回して選択・押して移動)

const fs = require('node:fs');
const path = require('node:path');
const { WsClient } = require('./ws-client');
const { ConfigStore } = require('./config');
const { HerdrCli, buildAgents, mostUrgent, countByStatus } = require('./herdr');
const { SlotBook, orderKeys } = require('./slots');
const { renderAgent, renderEmpty, renderSummary, renderError } = require('./render');
const { raiseTerminal } = require('./focus');

const AGENT_ACTION = 'com.kuruusuniku.herdr-deck.agent';
const SUMMARY_ACTION = 'com.kuruusuniku.herdr-deck.summary';
const LOG_FILE = path.join(__dirname, 'log', 'plugin.log');
const LOG_MAX_BYTES = 512 * 1024;

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ログの失敗でキー操作を止めない
  }
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 2; i < argv.length - 1; i += 1) {
    if (argv[i].startsWith('-')) flags.set(argv[i].replace(/^-+/, ''), argv[i + 1]);
  }
  return { port: flags.get('port'), pluginUUID: flags.get('pluginUUID'), registerEvent: flags.get('registerEvent') };
}

function describeError(err) {
  if (err.code === 'HERDR_NOT_FOUND' || err.code === 'ENOENT') return ['herdr が見つかりません', 'config の herdr.bin を設定'];
  const msg = String(err.message || err);
  // herdr CLI: "no herdr server is running at <socket>; run `herdr` to start or attach it"
  if (/no herdr server|server_not_running|not running|ECONNREFUSED|connection refused/i.test(msg)) return ['herdr 未接続', 'herdr を起動してください'];
  if (err.killed || err.code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return ['herdr 応答なし', msg];
  return ['herdr エラー', msg];
}

class Deck {
  constructor({ send, config = new ConfigStore(), createHerdr = (opts) => new HerdrCli(opts), raise = raiseTerminal, now = () => Date.now(), logger = log } = {}) {
    this.send = send;
    this.config = config;
    this.createHerdr = createHerdr;
    this.raise = raise;
    this.now = now;
    this.log = logger;
    this.keys = new Map(); // context -> { action, device, row, column, knob, cursor, lastImage }
    this.book = new SlotBook();
    this.agents = [];
    this.slots = [];
    this.error = null;
    this.tick = 0;
    this.refreshing = null;
    this.config.refresh();
    this.herdr = this.createHerdr(this.config.value.herdr);
  }

  get cfg() {
    return this.config.value;
  }

  handle(message) {
    const { event, action, context, device, payload = {} } = message;
    if (event === 'willAppear') {
      this.keys.set(context, {
        action,
        device: device || '',
        row: Number(payload.coordinates?.row ?? 0),
        column: Number(payload.coordinates?.column ?? 0),
        knob: payload.controller === 'Knob',
        cursor: 0,
        lastImage: null,
      });
      this.paintAll();
      return null;
    }
    if (event === 'willDisappear') {
      this.keys.delete(context);
      this.paintAll(); // 位置順の番号を詰め直す
      return null;
    }
    const key = this.keys.get(context);
    if (!key) return null;
    if (event === 'keyUp' || event === 'dialDown') return this.press(context);
    if (event === 'dialRotate' && key.action === SUMMARY_ACTION) {
      const step = Math.sign(Number(payload.ticks) || 0);
      if (step && this.agents.length) {
        key.cursor = (key.cursor + step + this.agents.length) % this.agents.length;
        this.paint(context);
      }
    }
    return null;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (this.config.refresh()) {
        this.herdr = this.createHerdr(this.cfg.herdr);
        this.log(this.config.error || 'config reloaded');
      }
      try {
        this.agents = buildAgents(await this.herdr.snapshot());
        this.book.update(this.agents, this.now());
        this.slots = this.book.layout(this.agents, this.cfg.deck.order);
        if (this.error) this.log('herdr reconnected');
        this.error = null;
      } catch (err) {
        const [title, detail] = describeError(err);
        if (!this.error || this.error[0] !== title) this.log(`refresh failed: ${err.message}`);
        this.error = [title, detail];
      }
      this.paintAll();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  animate() {
    this.tick += 1;
    this.paintAll();
  }

  agentKeyOrder() {
    const agentKeys = [...this.keys].filter(([, k]) => k.action === AGENT_ACTION).map(([context, k]) => ({ context, ...k }));
    return orderKeys(agentKeys);
  }

  paintAll() {
    this.agentKeyOrder().forEach((context, index) => this.paint(context, index));
    for (const [context, key] of this.keys) if (key.action === SUMMARY_ACTION) this.paint(context);
  }

  imageFor(context, index) {
    const key = this.keys.get(context);
    const now = this.now();
    const opts = (agent) => ({ agents: this.agents, since: this.book.statusSince(agent.id), now, tick: this.tick, animate: this.cfg.deck.animate });
    if (this.error) return renderError(...this.error);
    if (key.action === SUMMARY_ACTION) {
      if (key.knob && this.agents.length) {
        const agent = this.agents[key.cursor % this.agents.length];
        return renderAgent(agent, opts(agent));
      }
      return renderSummary(countByStatus(this.agents), { tick: this.tick, total: this.agents.length });
    }
    const slot = index ?? this.agentKeyOrder().indexOf(context);
    const agent = this.slots[slot];
    return agent ? renderAgent(agent, opts(agent)) : renderEmpty(slot);
  }

  paint(context, index) {
    const key = this.keys.get(context);
    if (!key) return;
    const image = this.imageFor(context, index);
    if (image === key.lastImage) return;
    key.lastImage = image;
    this.send({ event: 'setImage', context, payload: { target: 0, image } });
  }

  targetFor(context) {
    const key = this.keys.get(context);
    if (key.action === SUMMARY_ACTION) {
      return key.knob && this.agents.length ? this.agents[key.cursor % this.agents.length] : mostUrgent(this.agents);
    }
    return this.slots[this.agentKeyOrder().indexOf(context)] || null;
  }

  async press(context) {
    const target = this.error ? null : this.targetFor(context);
    if (!target) {
      this.send({ event: 'showAlert', context });
      return;
    }
    try {
      await this.herdr.focusAgent(target.paneId);
    } catch (err) {
      this.log(`agent focus ${target.paneId} failed: ${err.message}`);
      this.send({ event: 'showAlert', context });
      return;
    }
    try {
      const app = await this.raise(this.cfg.deck.terminalApp);
      this.log(`jumped to ${target.paneId} (${target.workspace}) via ${app || 'herdr only'}`);
    } catch (err) {
      this.log(`raise terminal failed: ${err.message}`);
    }
    await this.refresh(); // focus で「完了」が既読になるので即反映
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.port) {
    console.error('usage: node index.js -port <port> -pluginUUID <uuid> -registerEvent <event> -info <json>');
    process.exit(2);
  }
  const ws = new WsClient(`ws://127.0.0.1:${args.port}`);
  const deck = new Deck({ send: (msg) => ws.send(JSON.stringify(msg)) });

  const loop = (fn, intervalOf) => {
    const step = async () => {
      try {
        await fn();
      } catch (err) {
        log(`loop error: ${err.stack || err}`);
      }
      setTimeout(step, intervalOf());
    };
    step();
  };

  ws.on('open', () => {
    log(`connected (port ${args.port})`);
    ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
    loop(() => deck.refresh(), () => deck.cfg.deck.pollMs);
    loop(() => deck.animate(), () => deck.cfg.deck.frameMs);
  });
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    Promise.resolve(deck.handle(message)).catch((err) => log(`handler error: ${err.stack || err}`));
  });
  ws.on('error', (err) => log(`socket error: ${err.message}`));
  ws.on('close', () => {
    log('socket closed, exiting');
    process.exit(0);
  });
  process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err}`));
  process.on('unhandledRejection', (err) => log(`unhandled: ${err && err.stack ? err.stack : err}`));
}

if (require.main === module) main();

module.exports = { Deck, parseArgs, describeError, AGENT_ACTION, SUMMARY_ACTION };
