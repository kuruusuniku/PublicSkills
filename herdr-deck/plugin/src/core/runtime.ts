import { ConfigStore } from "./config.ts";
import type { KeySink } from "./deck-controller.ts";
import { DeckController } from "./deck-controller.ts";
import { augmentedPath, HerdrClient } from "./herdr.ts";
import { HerdrMonitor } from "./monitor.ts";
import { Narrator } from "./narrator.ts";
import type { ImageFormat } from "./render.ts";
import type { Logger } from "./types.ts";

export interface Runtime {
  config: ConfigStore;
  herdr: HerdrClient;
  monitor: HerdrMonitor;
  narrator: Narrator;
  controller: DeckController;
  /** herdr の監視とアニメーションを始める (デバイスと繋がってから呼ぶ) */
  start(): void;
  stop(): void;
}

/** Stream Deck / VSD Craft のどちらからも使う、プラグインの中身一式 */
export function startRuntime(opts: { logger: Logger; sink: KeySink; defaultImageFormat: ImageFormat; configPath?: string }): Runtime {
  const { logger } = opts;
  // デバイスのアプリから起動されると PATH が最小限なので、herdr や再生コマンドを見つけられるようにする
  process.env.PATH = augmentedPath();

  const config = new ConfigStore(opts.configPath, logger);
  if (config.ensureFile()) logger.info(`設定ファイルを作成しました: ${config.path}`);
  const initial = config.get();

  const herdr = new HerdrClient({ bin: initial.herdr.path, session: initial.herdr.session, timeoutMs: initial.herdr.timeoutMs });
  const monitor = new HerdrMonitor(herdr, config, logger);
  const narrator = new Narrator({ config, herdr, logger });
  const controller = new DeckController({
    config,
    herdr,
    monitor,
    narrator,
    logger,
    sink: opts.sink,
    defaultImageFormat: opts.defaultImageFormat,
  });

  monitor.on("update", () => controller.render(false));
  monitor.on("offline", () => controller.render(false));
  monitor.on("narration", (ev) => narrator.enqueue(ev));

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // アニメーション用のタイマー。frameMs は設定変更で変わりうるので毎回読む
  const tick = () => {
    if (!running) return;
    controller.tick();
    timer = setTimeout(tick, config.get().deck.frameMs);
  };

  return {
    config,
    herdr,
    monitor,
    narrator,
    controller,
    start() {
      if (running) return;
      running = true;
      monitor.start();
      timer = setTimeout(tick, config.get().deck.frameMs);
    },
    stop() {
      running = false;
      monitor.stop();
      if (timer) clearTimeout(timer);
    },
  };
}
