import { execFile } from "node:child_process";
import type { KeyAction, KeyDownEvent, KeyUpEvent, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { action, SingletonAction } from "@elgato/streamdeck";
import type { ConfigStore } from "../core/config.ts";
import type { HerdrClient } from "../core/herdr.ts";
import type { HerdrMonitor } from "../core/monitor.ts";
import type { Narrator } from "../core/narrator.ts";
import { renderKeySvg, svgDataUrl } from "../core/render.ts";
import { assignSlots } from "../core/slots.ts";
import type { Logger, NarrationEvent, TabView } from "../core/types.ts";

type TabKeySettings = {
  /** 1始まりのタブ番号。空なら位置で自動割り当て */
  slot?: number | string | null;
};

interface KeyEntry {
  action: KeyAction<TabKeySettings>;
  device: string;
  column?: number;
  row?: number;
  slot: number | null;
  lastImage: string | null;
  pressedAt: number | null;
}

export interface TabActionDeps {
  config: ConfigStore;
  herdr: HerdrClient;
  monitor: HerdrMonitor;
  narrator: Narrator;
  logger: Logger;
}

/** 長押しとみなす時間 */
const LONG_PRESS_MS = 600;

function parseSlot(v: TabKeySettings["slot"]): number | null {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * herdr のタブ1つを受け持つボタン。
 * - 色とドット絵で 作業中 / 確認待ち / 完了 / 待機 を表示
 * - 短押し: そのタブ(注目すべきペイン)へ移動
 * - 長押し: ずんだもんが今の様子を読み上げる
 */
@action({ UUID: "com.kuruusuniku.herdr-deck.tab" })
export class HerdrTabAction extends SingletonAction<TabKeySettings> {
  #deps: TabActionDeps;
  #keys = new Map<string, KeyEntry>();
  #slots = new Map<string, number>();
  #frame = 0;

  constructor(deps: TabActionDeps) {
    super();
    this.#deps = deps;
  }

  override onWillAppear(ev: WillAppearEvent<TabKeySettings>): void {
    if (!ev.action.isKey()) return;
    this.#keys.set(ev.action.id, {
      action: ev.action,
      device: ev.action.device.id,
      column: ev.action.coordinates?.column,
      row: ev.action.coordinates?.row,
      slot: parseSlot(ev.payload.settings.slot),
      lastImage: null,
      pressedAt: null,
    });
    this.#reassign();
    this.render(true);
  }

  override onWillDisappear(ev: WillDisappearEvent<TabKeySettings>): void {
    this.#keys.delete(ev.action.id);
    this.#reassign();
    this.render(true);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TabKeySettings>): void {
    const entry = this.#keys.get(ev.action.id);
    if (!entry) return;
    entry.slot = parseSlot(ev.payload.settings.slot);
    this.#reassign();
    this.render(true);
  }

  override onKeyDown(ev: KeyDownEvent<TabKeySettings>): void {
    const entry = this.#keys.get(ev.action.id);
    if (entry) entry.pressedAt = Date.now();
  }

  override async onKeyUp(ev: KeyUpEvent<TabKeySettings>): Promise<void> {
    const entry = this.#keys.get(ev.action.id);
    if (!entry) return;
    const held = entry.pressedAt === null ? 0 : Date.now() - entry.pressedAt;
    entry.pressedAt = null;
    const view = this.#viewFor(ev.action.id);
    if (!view) {
      await entry.action.showAlert();
      return;
    }
    try {
      if (held >= LONG_PRESS_MS) await this.#askStatus(view);
      else await this.#focus(view);
    } catch (err) {
      this.#deps.logger.warn(`ボタン操作に失敗: ${(err as Error).message}`);
      await entry.action.showAlert();
    }
  }

  /** プラグイン側のタイマーから呼ばれる。動きのあるボタンだけ描き直す */
  tick(): void {
    if (this.#deps.config.get().deck.animation) this.#frame++;
    this.render(false);
  }

  render(force: boolean): void {
    const tabs = this.#deps.monitor.tabs;
    const offline = !this.#deps.monitor.online;
    for (const [id, entry] of this.#keys) {
      const index = this.#slots.get(id) ?? 0;
      const view = tabs[index] ?? null;
      // 止まっている絵は毎回同じ文字列になるので、前回と同じなら送らない
      const image = svgDataUrl(renderKeySvg({ view, offline, slot: index + 1, frame: this.#frame }));
      if (!force && image === entry.lastImage) continue;
      entry.lastImage = image;
      entry.action.setImage(image).catch((err: Error) => this.#deps.logger.debug(`setImage: ${err.message}`));
    }
  }

  #reassign(): void {
    this.#slots = assignSlots(
      [...this.#keys.entries()].map(([id, e]) => ({ id, device: e.device, column: e.column, row: e.row, slot: e.slot })),
    );
  }

  #viewFor(id: string): TabView | null {
    const index = this.#slots.get(id);
    if (index === undefined) return null;
    return this.#deps.monitor.tabs[index] ?? null;
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
