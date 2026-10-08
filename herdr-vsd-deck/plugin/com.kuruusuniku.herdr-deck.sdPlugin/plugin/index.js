#!/bin/sh
":" //; for n in "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/share/mise/shims/node "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$n" ] && exec "$n" "$0" "$@"; done; echo "node が見つかりません" >&2; exit 127
'use strict';

// VSD Craft (Mirabox Stream Dock) プラグインのエントリポイント。
// VSD Craft が組み込みの Node で `node index.js -port P -pluginUUID U -registerEvent E -info JSON` と起動する。
// 上の2行は、組み込み Node を持たない VSD Craft がこのファイルを直接実行した場合に、
// sh として Homebrew などの node を探して起動し直すためのもの (Node からはコメントに見える)。
//
// ボタンの配置は SIOS Tech Lab の記事と同じ考え方:
//   herdr スペース: herdr のスペース (workspace)。押すとそのスペースを選び、herdr でもフォーカスする。
//                   選択中のスペースをもう一度押すと、タブのボタンが次のページ (次の N タブ) に切り替わる。
//                   ボタンには、そのスペースのタブにいる住人の顔が並ぶ
//   herdr タブ:     選んだスペースのタブ。住人のドット絵がエージェントの状態を演じる。押すとそのタブへ移動
//   どのボタンが何番目を表示するかは、設定画面のスロット (1〜16) で決める。空なら置いた位置の順 (左上から)
// ほかに、画面の無いボタン (VSD M18 の下の3つなど) にも置けるアクション:
//   herdr サマリー (確認待ちなど一番急ぎのタブへ) / herdr 次へ (急ぎ順に次のタブへ) / 読み上げミュート

const fs = require('node:fs');
const path = require('node:path');
const { WsClient } = require('./ws-client');
const { ConfigStore, mutePath } = require('./config');
const { HerdrCli, buildModel, mostUrgent, urgencyOrder, countByStatus } = require('./herdr');
const { renderTab, renderSpace, renderSummary, renderNext, renderMute, renderError } = require('./render');
const { raiseTerminal } = require('./focus');
const { LedRing, ringColor } = require('./led');
const { Voice } = require('./voice');

const SPACE_ACTION = 'com.kuruusuniku.herdr-deck.space';
const TAB_ACTION = 'com.kuruusuniku.herdr-deck.tab';
const SUMMARY_ACTION = 'com.kuruusuniku.herdr-deck.summary';
const NEXT_ACTION = 'com.kuruusuniku.herdr-deck.next';
const MUTE_ACTION = 'com.kuruusuniku.herdr-deck.mute';
const OFF = [0, 0, 0];
const LOG_FILE = path.join(__dirname, 'log', 'plugin.log');
const LOG_MAX_BYTES = 512 * 1024;
const EMPTY_MODEL = { spaces: [], tabs: [], panes: [], focusedWorkspaceId: null, focusedTabId: null };

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

// 設定画面の select は文字列で保存されることがあるので数値に直す。1〜16 以外は「自動」
function parseSlot(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

// デバイス上の位置 (行→列) の順
function orderKeys(keys) {
  return [...keys]
    .sort((a, b) => String(a.device).localeCompare(String(b.device)) || a.row - b.row || a.column - b.column || String(a.context).localeCompare(String(b.context)))
    .map((k) => k.context);
}

// [見出し, 詳細, 64px キー用の短い表記]
function describeError(err) {
  if (err.code === 'HERDR_NOT_FOUND' || err.code === 'ENOENT') return ['herdr が見つかりません', 'config の herdr.bin を設定', '見つからず'];
  const msg = String(err.message || err);
  // herdr CLI: "no herdr server is running at <socket>; run `herdr` to start or attach it"
  if (/no herdr server|server_not_running|not running|ECONNREFUSED|connection refused/i.test(msg)) return ['herdr 未接続', 'herdr を起動してください', '未接続'];
  if (err.killed || err.code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return ['herdr 応答なし', msg, '応答なし'];
  return ['herdr エラー', msg, 'エラー'];
}

class Deck {
  constructor({
    send,
    config = new ConfigStore(),
    createHerdr = (opts) => new HerdrCli(opts),
    createLed = (opts) => new LedRing(opts),
    createVoice = (opts) => new Voice(opts),
    raise = raiseTerminal,
    muteFile = mutePath(),
    logger = log,
  } = {}) {
    this.send = send;
    this.config = config;
    this.createHerdr = createHerdr;
    this.createLed = createLed;
    this.raise = raise;
    this.muteFile = muteFile;
    this.log = logger;
    this.keys = new Map(); // context -> { action, device, row, column, slot, knob, cursor, lastImage }
    this.model = EMPTY_MODEL;
    this.error = null;
    this.tick = 0;
    this.refreshing = null;
    this.led = null;
    this.selectedSpaceId = null;
    this.lastSeenFocus = null; // 前回の snapshot で herdr がフォーカスしていたスペース (変わったら追従する)
    this.pageBySpace = new Map();
    this.muted = fs.existsSync(muteFile);
    this.config.refresh();
    this.herdr = this.createHerdr(this.config.value.herdr);
    this.voice = createVoice({
      config: () => this.cfg.voice,
      herdr: () => this.herdr,
      log: this.log,
      isMuted: () => fs.existsSync(this.muteFile),
    });
  }

  get cfg() {
    return this.config.value;
  }

  // ---------------------------------------------------------------- VSD Craft からのイベント

  handle(message) {
    const { event, action, context, device, payload = {} } = message;
    if (event === 'willAppear') {
      this.keys.set(context, {
        action,
        device: device || '',
        row: Number(payload.coordinates?.row ?? 0),
        column: Number(payload.coordinates?.column ?? 0),
        slot: parseSlot(payload.settings?.slot),
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
    if (event === 'didReceiveSettings') {
      key.slot = parseSlot(payload.settings?.slot);
      this.paintAll();
      return null;
    }
    if (event === 'keyUp' || event === 'dialDown') return this.press(context);
    if (event === 'dialRotate' && key.action === SUMMARY_ACTION) {
      const order = urgencyOrder(this.model.tabs);
      const step = Math.sign(Number(payload.ticks) || 0);
      if (step && order.length) {
        key.cursor = (key.cursor + step + order.length) % order.length;
        this.paint(context);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- herdr の状態

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (this.config.refresh()) {
        this.herdr = this.createHerdr(this.cfg.herdr);
        this.log(this.config.error || 'config reloaded');
      }
      this.muted = fs.existsSync(this.muteFile);
      try {
        this.model = buildModel(await this.herdr.snapshot());
        this.syncSelection();
        if (this.error) this.log('herdr reconnected');
        this.error = null;
        this.voice.observe(this.model);
      } catch (err) {
        const described = describeError(err);
        if (!this.error || this.error[0] !== described[0]) this.log(`refresh failed: ${err.message}`);
        this.error = described;
      }
      this.paintAll();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // 選んでいるスペースを決める。herdr 側でフォーカスが「変わったとき」だけ追従する
  // (デッキで選んだスペースを、次の更新で引き戻さないように)
  syncSelection() {
    const { spaces, focusedWorkspaceId } = this.model;
    if (focusedWorkspaceId && focusedWorkspaceId !== this.lastSeenFocus) {
      this.lastSeenFocus = focusedWorkspaceId;
      this.selectSpace(focusedWorkspaceId);
    }
    if (!spaces.some((s) => s.id === this.selectedSpaceId)) this.selectedSpaceId = spaces[0]?.id ?? null;
    const space = this.selectedSpace();
    if (space) this.pageBySpace.set(space.id, Math.min(this.pageBySpace.get(space.id) || 0, this.pageCount(space) - 1));
  }

  selectSpace(spaceId, tabId = null) {
    this.selectedSpaceId = spaceId;
    const space = this.model.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    // 見たいタブ (指定が無ければ herdr でアクティブなタブ) が出るページにする
    const index = space.tabs.findIndex((t) => t.id === (tabId || space.activeTabId));
    if (index >= 0) this.pageBySpace.set(space.id, Math.floor(index / this.pageSize()));
  }

  selectedSpace() {
    return this.model.spaces.find((s) => s.id === this.selectedSpaceId) || null;
  }

  // ---------------------------------------------------------------- ボタンと表示の対応

  keysOf(action) {
    return [...this.keys].filter(([, k]) => k.action === action).map(([context, k]) => ({ context, ...k }));
  }

  // そのボタンが何番目 (0 始まり) を表示するか: スロット指定があればそれ、無ければ置いた位置の順
  slotIndex(context) {
    const key = this.keys.get(context);
    if (key.slot) return key.slot - 1;
    return orderKeys(this.keysOf(key.action).filter((k) => !k.slot)).indexOf(context);
  }

  // タブのボタン1ページ分の数 (= タブのボタンの数。スロット指定が大きければそれ)
  pageSize() {
    const tabKeys = this.keysOf(TAB_ACTION);
    return Math.max(1, tabKeys.length, ...tabKeys.map((k) => k.slot || 0));
  }

  pageCount(space) {
    return Math.max(1, Math.ceil(space.tabs.length / this.pageSize()));
  }

  spaceFor(context) {
    return this.model.spaces[this.slotIndex(context)] || null;
  }

  tabFor(context) {
    const space = this.selectedSpace();
    if (!space) return null;
    return space.tabs[(this.pageBySpace.get(space.id) || 0) * this.pageSize() + this.slotIndex(context)] || null;
  }

  // ---------------------------------------------------------------- 描画

  animate() {
    this.tick += 1;
    this.paintAll();
    this.updateLed();
  }

  updateLed() {
    if (this.cfg.deck.ledRing && !this.led) this.led = this.createLed({ log: this.log });
    if (!this.led) return;
    if (!this.cfg.deck.ledRing) {
      this.led.show(OFF);
      this.led.close();
      this.led = null;
      return;
    }
    this.led.show(this.error ? OFF : ringColor(countByStatus(this.model.tabs), this.tick));
  }

  paintAll() {
    for (const context of this.keys.keys()) this.paint(context);
  }

  imageFor(context) {
    const key = this.keys.get(context);
    const tick = this.tick;
    if (key.action === MUTE_ACTION) return renderMute(this.muted);
    if (this.error) return renderError(...this.error);
    if (key.action === SPACE_ACTION) {
      const space = this.spaceFor(context);
      const selected = Boolean(space) && space.id === this.selectedSpaceId;
      return renderSpace(space, { selected, page: space ? this.pageBySpace.get(space.id) || 0 : 0, pages: space ? this.pageCount(space) : 1, tick });
    }
    if (key.action === TAB_ACTION) {
      const tab = this.tabFor(context);
      const active = Boolean(tab) && tab.id === this.selectedSpace()?.activeTabId;
      return renderTab(tab, { selected: active, tick, animate: this.cfg.deck.animate });
    }
    const counts = countByStatus(this.model.tabs);
    if (key.action === NEXT_ACTION) return renderNext(counts.blocked + counts.done, { tick });
    // サマリー: ノブなら選んでいるタブ、キーなら状態ごとの数
    if (key.knob) {
      const order = urgencyOrder(this.model.tabs);
      if (order.length) return renderTab(order[key.cursor % order.length], { tick, animate: this.cfg.deck.animate });
    }
    return renderSummary(counts, { tick });
  }

  paint(context) {
    const key = this.keys.get(context);
    if (!key) return;
    const image = this.imageFor(context);
    if (image === key.lastImage) return; // 前回と同じ絵なら送らない
    key.lastImage = image;
    this.send({ event: 'setImage', context, payload: { target: 0, image } });
  }

  // ---------------------------------------------------------------- 押したとき

  // 「次へ」: 急ぎ順で、いま herdr がフォーカスしているタブの次
  nextTab() {
    const order = urgencyOrder(this.model.tabs);
    if (!order.length) return null;
    return order[(order.findIndex((t) => t.id === this.model.focusedTabId) + 1) % order.length];
  }

  toggleMute(context) {
    try {
      if (this.muted) fs.rmSync(this.muteFile, { force: true });
      else {
        fs.mkdirSync(path.dirname(this.muteFile), { recursive: true });
        fs.writeFileSync(this.muteFile, `${new Date().toISOString()}\n`);
      }
      this.muted = !this.muted;
      this.log(`voice ${this.muted ? 'muted' : 'unmuted'}`);
    } catch (err) {
      this.log(`mute toggle failed: ${err.message}`);
      this.send({ event: 'showAlert', context });
    }
    this.paintAll();
  }

  async bringTerminal() {
    try {
      const app = await this.raise(this.cfg.deck.terminalApp);
      return app || 'herdr only';
    } catch (err) {
      this.log(`raise terminal failed: ${err.message}`);
      return 'herdr only';
    }
  }

  async jumpToTab(tab, context) {
    try {
      await this.herdr.focusTab(tab.id);
    } catch (err) {
      this.log(`tab focus ${tab.id} failed: ${err.message}`);
      this.send({ event: 'showAlert', context });
      return;
    }
    this.selectSpace(tab.workspaceId, tab.id);
    this.paintAll();
    this.log(`jumped to ${tab.id} (${tab.spaceLabel} / ${tab.label}) via ${await this.bringTerminal()}`);
    await this.refresh(); // tab focus で「完了」が既読になるので即反映
  }

  async pressSpace(context) {
    const space = this.spaceFor(context);
    if (!space) {
      this.send({ event: 'showAlert', context });
      return;
    }
    if (space.id === this.selectedSpaceId) {
      // 選択中のスペースをもう一度押すと、タブのボタンが次のページへ (最後まで行ったら最初へ)
      const pages = this.pageCount(space);
      if (pages > 1) {
        this.pageBySpace.set(space.id, ((this.pageBySpace.get(space.id) || 0) + 1) % pages);
        this.paintAll();
        return;
      }
    }
    try {
      await this.herdr.focusWorkspace(space.id);
    } catch (err) {
      this.log(`workspace focus ${space.id} failed: ${err.message}`);
      this.send({ event: 'showAlert', context });
      return;
    }
    this.selectSpace(space.id);
    this.paintAll();
    this.log(`selected space ${space.id} (${space.label}) via ${await this.bringTerminal()}`);
    await this.refresh();
  }

  async press(context) {
    const key = this.keys.get(context);
    if (key.action === MUTE_ACTION) {
      this.toggleMute(context);
      return;
    }
    if (this.error) {
      this.send({ event: 'showAlert', context });
      return;
    }
    if (key.action === SPACE_ACTION) {
      await this.pressSpace(context);
      return;
    }
    let tab = null;
    if (key.action === TAB_ACTION) tab = this.tabFor(context);
    else if (key.action === NEXT_ACTION) tab = this.nextTab();
    else if (key.action === SUMMARY_ACTION) {
      const order = urgencyOrder(this.model.tabs);
      tab = key.knob && order.length ? order[key.cursor % order.length] : mostUrgent(this.model.tabs);
    }
    if (!tab) {
      this.send({ event: 'showAlert', context });
      return;
    }
    await this.jumpToTab(tab, context);
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

  // ポーリングとアニメーションは、それぞれ全ボタンで1本のタイマーを共有する
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

module.exports = {
  Deck, parseArgs, parseSlot, orderKeys, describeError, SPACE_ACTION, TAB_ACTION, SUMMARY_ACTION, NEXT_ACTION, MUTE_ACTION,
};
