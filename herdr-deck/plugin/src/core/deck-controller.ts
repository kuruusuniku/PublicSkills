import { execFile } from "node:child_process";
import type { ConfigStore } from "./config.ts";
import type { HerdrClient } from "./herdr.ts";
import type { HerdrMonitor } from "./monitor.ts";
import type { Narrator } from "./narrator.ts";
import type { ImageFormat } from "./render.ts";
import { renderKeyImage } from "./render.ts";
import { assignSlots } from "./slots.ts";
import type { Logger, NarrationEvent, TabView } from "./types.ts";

/** ボタンへの出力。Stream Deck (Elgato SDK) と VSD Craft (生の WebSocket) で実装が違う */
export interface KeySink {
  setImage(keyId: string, image: string): void;
  showAlert(keyId: string): void;
}

export interface KeyPlacementInfo {
  id: string;
  device: string;
  column?: number;
  row?: number;
  slot: number | null;
}

export interface DeckControllerDeps {
  config: ConfigStore;
  herdr: Pick<HerdrClient, "focusAgent" | "focusTab">;
  monitor: Pick<HerdrMonitor, "tabs" | "online" | "pollOnce">;
  narrator: Pick<Narrator, "enqueue">;
  logger: Logger;
  sink: KeySink;
  /** 画像の渡し方の既定値 (config の deck.imageFormat が "auto" のとき使う) */
  defaultImageFormat: ImageFormat;
  now?: () => number;
}

interface KeyEntry extends KeyPlacementInfo {
  lastImage: string | null;
  pressedAt: number | null;
}

/** 長押しとみなす時間 */
export const LONG_PRESS_MS = 600;

/** プロパティインスペクタの「タブ番号」(文字列で来ることもある) を 1 以上の整数にする */
export function parseSlot(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * herdr のタブを受け持つボタン群の振る舞い (デバイスの SDK に依存しない部分)。
 * - 色とドット絵で 作業中 / 確認待ち / 完了 / 待機 を表示
 * - 短押し: そのタブ(注目すべきペイン)へ移動
 * - 長押し: ずんだもんが今の様子を読み上げる
 */
export class DeckController {
  #deps: DeckControllerDeps;
  #keys = new Map<string, KeyEntry>();
  #slots = new Map<string, number>();
  #frame = 0;
  #now: () => number;

  constructor(deps: DeckControllerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  keyAppear(info: KeyPlacementInfo): void {
    this.#keys.set(info.id, { ...info, lastImage: null, pressedAt: null });
    this.#reassign();
    this.render(true);
  }

  keyDisappear(id: string): void {
    if (!this.#keys.delete(id)) return;
    this.#reassign();
    this.render(true);
  }

  keySettings(id: string, slot: number | null): void {
    const entry = this.#keys.get(id);
    if (!entry) return;
    entry.slot = slot;
    this.#reassign();
    this.render(true);
  }

  keyDown(id: string): void {
    const entry = this.#keys.get(id);
    if (entry) entry.pressedAt = this.#now();
  }

  async keyUp(id: string): Promise<void> {
    const entry = this.#keys.get(id);
    if (!entry) return;
    const held = entry.pressedAt === null ? 0 : this.#now() - entry.pressedAt;
    entry.pressedAt = null;
    const view = this.viewFor(id);
    if (!view) {
      this.#deps.sink.showAlert(id);
      return;
    }
    try {
      if (held >= LONG_PRESS_MS) await this.#askStatus(view);
      else await this.#focus(view);
    } catch (err) {
      this.#deps.logger.warn(`ボタン操作に失敗: ${(err as Error).message}`);
      this.#deps.sink.showAlert(id);
    }
  }

  /** アニメーション用のタイマーから呼ばれる */
  tick(): void {
    if (this.#deps.config.get().deck.animation) this.#frame++;
    this.render(false);
  }

  render(force: boolean): void {
    const { monitor, config, sink } = this.#deps;
    const configured = config.get().deck.imageFormat;
    const format = configured === "auto" ? this.#deps.defaultImageFormat : configured;
    const offline = !monitor.online;
    for (const [id, entry] of this.#keys) {
      const index = this.#slots.get(id) ?? 0;
      const view = monitor.tabs[index] ?? null;
      // 止まっている絵は毎回同じ文字列になるので、前回と同じなら送らない
      const image = renderKeyImage({ view, offline, slot: index + 1, frame: this.#frame }, format);
      if (!force && image === entry.lastImage) continue;
      entry.lastImage = image;
      sink.setImage(id, image);
    }
  }

  viewFor(id: string): TabView | null {
    const index = this.#slots.get(id);
    if (index === undefined) return null;
    return this.#deps.monitor.tabs[index] ?? null;
  }

  get keyCount(): number {
    return this.#keys.size;
  }

  #reassign(): void {
    this.#slots = assignSlots([...this.#keys.values()]);
  }

  async #focus(view: TabView): Promise<void> {
    const { herdr, monitor, config } = this.#deps;
    if (view.attentionPaneId) await herdr.focusAgent(view.attentionPaneId);
    else await herdr.focusTab(view.tabId);
    activateApp(config.get().deck.activateApp, this.#deps.logger);
    // 既読になって色が戻るのをすぐ見せる
    await monitor.pollOnce();
    this.render(false);
  }

  async #askStatus(view: TabView): Promise<void> {
    if (!view.attentionPaneId || view.state === "none") throw new Error("このタブにはエージェントがいません");
    const event: NarrationEvent = {
      kind: "status",
      paneId: view.attentionPaneId,
      tabId: view.tabId,
      workspaceId: view.workspaceId,
      workspaceLabel: view.workspaceLabel,
      tabLabel: view.tabLabel,
      multiTab: view.multiTab,
      agentLabel: view.agentLabel ?? "agent",
      focused: view.focused,
      state: view.state,
    };
    if (!this.#deps.narrator.enqueue(event)) throw new Error("読み上げが無効になっています (voice.enabled)");
  }
}

/** ターミナルアプリを前面に出す (macOS のみ) */
function activateApp(app: string | null, logger: Logger): void {
  if (!app || process.platform !== "darwin") return;
  execFile("open", ["-a", app], (err) => {
    if (err) logger.warn(`${app} を前面に出せません: ${err.message}`);
  });
}
