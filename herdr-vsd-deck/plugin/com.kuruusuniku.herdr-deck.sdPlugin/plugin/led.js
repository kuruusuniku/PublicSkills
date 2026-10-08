'use strict';

// VSD M18 の RGB ライト (枠の22個 + 前面2個) を、一番急ぎの状態の色で光らせる。実験的・opt-in。
//   確認待ち: オレンジで脈動 / 完了: 緑 / 作業中: 青 / 全員待機: 消灯
//
// プラグイン API には LED を操作する手段が無いので、USB HID で直接 SETLB コマンドを送る。
// プロトコルは https://github.com/bidoofgoo/streamdock-m18 の PROTOCOL.md による:
//   [0x00 (report ID)] + "CRT\0\0" + "SETLB" + [r,g,b] x 24 を、report ID の後ろ 1024 バイトまで 0 埋め
//   (1024 バイトちょうどでないと黙って捨てられる)
// 注意:
//   - node-hid が要る (install.py --with-led が plugin/node_modules に入れる)
//   - VSD Craft が同じデバイスを使っているので nonExclusive で開く (macOS の hidapi は既定で占有し、
//     VSD Craft の画面が止まる)
//   - 明るさ (LBLIG) は送らない。直後の SETLB を消してしまう
//   - デバイスは何も応答しないので、届いたかどうかは目で見るしかない。色は定期的に送り直す

const VENDOR_ID = 0x5548;
const USAGE_PAGE = 0xffa0;
const LED_COUNT = 24;
const REPORT_SIZE = 1024;
const SETLB = [0x43, 0x52, 0x54, 0x00, 0x00, 0x53, 0x45, 0x54, 0x4c, 0x42];
const RESEND_MS = 2000;

const COLORS = {
  blocked: [[255, 110, 0], [70, 30, 0]], // tick ごとに切り替えて脈動
  done: [[0, 200, 60]],
  working: [[0, 50, 220]],
};

function buildFrame(rgb) {
  const frame = Buffer.alloc(1 + REPORT_SIZE);
  Buffer.from(SETLB).copy(frame, 1);
  for (let i = 0; i < LED_COUNT; i += 1) {
    frame.set(rgb, 1 + SETLB.length + i * 3);
  }
  return frame;
}

// 状態ごとの数 → リングの色 ([r,g,b])。誰も急いでいなければ消灯 ([0,0,0])。
function ringColor(counts, tick = 0) {
  for (const status of ['blocked', 'done', 'working']) {
    if (counts[status] > 0) {
      const colors = COLORS[status];
      return colors[tick % colors.length];
    }
  }
  return [0, 0, 0];
}

function loadHid() {
  try {
    return require('node-hid');
  } catch {
    return null;
  }
}

class LedRing {
  constructor({ hid = loadHid(), log = () => {}, productId = null, now = () => Date.now() } = {}) {
    this.hid = hid;
    this.log = log;
    this.productId = productId;
    this.now = now;
    this.device = null;
    this.last = null; // 最後に送った色 'r,g,b'
    this.sentAt = 0;
    this.failed = false;
    if (!hid) log('LED: node-hid が無いのでリングは光らせません (install.py --with-led で入ります)');
  }

  show(rgb) {
    if (!this.hid) return false;
    const key = rgb.join(',');
    const off = key === '0,0,0';
    const changed = key !== this.last;
    // 消灯は1回だけ送る。点灯中は VSD Craft に上書きされても戻るよう定期的に送り直す
    if (!changed && (off || this.now() - this.sentAt < RESEND_MS)) return false;
    if (!this.write(buildFrame(rgb))) return false;
    this.last = key;
    this.sentAt = this.now();
    return true;
  }

  open() {
    const info = this.hid.devices().find((d) => d.vendorId === VENDOR_ID && d.usagePage === USAGE_PAGE
      && (this.productId == null || d.productId === this.productId));
    if (!info) throw new Error('VSD M18 が見つかりません');
    return new this.hid.HID(info.path, { nonExclusive: true });
  }

  write(frame) {
    try {
      if (!this.device) this.device = this.open();
      this.device.write([...frame]);
      if (this.failed) this.log('LED: 再接続しました');
      this.failed = false;
      return true;
    } catch (err) {
      if (!this.failed) this.log(`LED: 書き込めません: ${err.message}`);
      this.failed = true;
      this.close(); // 抜き差しに備えて次回開き直す
      return false;
    }
  }

  close() {
    try {
      this.device?.close();
    } catch {
      // 既に切断されている
    }
    this.device = null;
  }
}

module.exports = { LedRing, buildFrame, ringColor, VENDOR_ID, USAGE_PAGE, REPORT_SIZE };
