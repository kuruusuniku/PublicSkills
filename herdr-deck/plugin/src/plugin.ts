// Elgato Stream Deck 用のエントリ (公式 SDK を使う)。VSD Craft 用は vsd.ts。
import streamDeck from "@elgato/streamdeck";
import { HerdrTabAction } from "./actions/herdr-tab.ts";
import { startRuntime } from "./core/runtime.ts";
import type { Logger } from "./core/types.ts";

const sdLogger = streamDeck.logger.createScope("herdr-deck");
const logger: Logger = {
  debug: (...a) => sdLogger.debug(a.map(String).join(" ")),
  info: (...a) => sdLogger.info(a.map(String).join(" ")),
  warn: (...a) => sdLogger.warn(a.map(String).join(" ")),
  error: (...a) => sdLogger.error(a.map(String).join(" ")),
};

const tabAction = new HerdrTabAction();
const findKey = (id: string) => tabAction.actions.find((a) => a.id === id);

const runtime = startRuntime({
  logger,
  defaultImageFormat: "svg-base64",
  sink: {
    setImage(id, image) {
      const a = findKey(id);
      if (a?.isKey()) a.setImage(image).catch((err: Error) => logger.debug(`setImage: ${err.message}`));
    },
    showAlert(id) {
      const a = findKey(id);
      if (a?.isKey()) a.showAlert().catch(() => {});
    },
  },
});
tabAction.controller = runtime.controller;

streamDeck.actions.registerAction(tabAction);
await streamDeck.connect();
runtime.start();
