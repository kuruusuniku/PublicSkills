import { EventEmitter } from "node:events";
import type { ConfigStore } from "./config.ts";
import type { HerdrClient } from "./herdr.ts";
import { HerdrError } from "./herdr.ts";
import { buildTabViews, EventDetector } from "./model.ts";
import type { Logger, NarrationEvent, SessionSnapshot, TabView } from "./types.ts";

export interface MonitorEvents {
  update: [tabs: TabView[], snapshot: SessionSnapshot];
  narration: [event: NarrationEvent];
  offline: [error: HerdrError];
}

/**
 * herdr を一定間隔 (既定 1.2 秒) でポーリングし、
 * - 毎回 "update" (ボタン表示用のタブ一覧)
 * - 完了/確認待ちが起きたら "narration"
 * - herdr に繋がらなくなったら "offline" (状態が変わったときだけ)
 * を出す。
 */
export class HerdrMonitor extends EventEmitter<MonitorEvents> {
  #herdr: HerdrClient;
  #config: ConfigStore;
  #logger: Logger;
  #detector = new EventDetector();
  #timer: NodeJS.Timeout | null = null;
  #wake: (() => void) | null = null;
  #running = false;
  #lastError: string | null = null;
  #serverVersion: string | null = null;
  tabs: TabView[] = [];

  constructor(herdr: HerdrClient, config: ConfigStore, logger: Logger) {
    super();
    this.#herdr = herdr;
    this.#config = config;
    this.#logger = logger;
  }

  get online(): boolean {
    return this.#lastError === null && this.#serverVersion !== null;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#wake?.();
  }

  /** 1回だけポーリングする (テストや CLI 用) */
  async pollOnce(): Promise<void> {
    const cfg = this.#config.get();
    this.#herdr.configure({ bin: cfg.herdr.path, session: cfg.herdr.session, timeoutMs: cfg.herdr.timeoutMs });
    this.#detector.cooldownMs = cfg.voice.cooldownMs;
    try {
      const snapshot = await this.#herdr.snapshot();
      if (this.#serverVersion !== null && this.#serverVersion !== snapshot.version) {
        this.#logger.info(`herdr サーバーが ${snapshot.version} に入れ替わりました`);
        this.#detector.reset();
      }
      this.#serverVersion = snapshot.version;
      if (this.#lastError !== null) this.#logger.info("herdr に再接続しました");
      this.#lastError = null;
      this.tabs = buildTabViews(snapshot, cfg.deck.tabs);
      this.emit("update", this.tabs, snapshot);
      for (const ev of this.#detector.update(snapshot)) this.emit("narration", ev);
    } catch (err) {
      const e = err instanceof HerdrError ? err : new HerdrError(String((err as Error)?.message ?? err), "error");
      if (this.#lastError !== e.message) {
        this.#logger.warn(`herdr: ${e.message}`);
        this.#lastError = e.message;
        // 再接続後にまとめてしゃべらないよう、取り直しからやり直す
        this.#detector.reset();
        this.#serverVersion = null;
        this.tabs = [];
        this.emit("offline", e);
      }
    }
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const started = Date.now();
      await this.pollOnce();
      if (!this.#running) break;
      const wait = Math.max(50, this.#config.get().herdr.pollMs - (Date.now() - started));
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        this.#timer = setTimeout(resolve, wait);
      });
      this.#wake = null;
    }
  }
}
