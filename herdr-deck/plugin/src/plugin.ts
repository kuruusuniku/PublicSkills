import streamDeck from "@elgato/streamdeck";
import { HerdrTabAction } from "./actions/herdr-tab.ts";
import { ConfigStore } from "./core/config.ts";
import { augmentedPath, HerdrClient } from "./core/herdr.ts";
import { HerdrMonitor } from "./core/monitor.ts";
import { Narrator } from "./core/narrator.ts";
import type { Logger } from "./core/types.ts";

// Stream Deck から起動されると PATH が最小限なので、herdr や再生コマンドを見つけられるようにする
process.env.PATH = augmentedPath();

const sdLogger = streamDeck.logger.createScope("herdr-deck");
const logger: Logger = {
  debug: (...a) => sdLogger.debug(a.map(String).join(" ")),
  info: (...a) => sdLogger.info(a.map(String).join(" ")),
  warn: (...a) => sdLogger.warn(a.map(String).join(" ")),
  error: (...a) => sdLogger.error(a.map(String).join(" ")),
};

const config = new ConfigStore(undefined, logger);
if (config.ensureFile()) logger.info(`設定ファイルを作成しました: ${config.path}`);
const initial = config.get();

const herdr = new HerdrClient({ bin: initial.herdr.path, session: initial.herdr.session, timeoutMs: initial.herdr.timeoutMs });
const monitor = new HerdrMonitor(herdr, config, logger);
const narrator = new Narrator({ config, herdr, logger });
const tabAction = new HerdrTabAction({ config, herdr, monitor, narrator, logger });

monitor.on("update", () => tabAction.render(false));
monitor.on("offline", () => tabAction.render(false));
monitor.on("narration", (ev) => narrator.enqueue(ev));

streamDeck.actions.registerAction(tabAction);
await streamDeck.connect();

monitor.start();

// アニメーション用のタイマー。frameMs は設定変更で変わりうるので毎回読む
const tick = () => {
  tabAction.tick();
  setTimeout(tick, config.get().deck.frameMs);
};
setTimeout(tick, initial.deck.frameMs);
