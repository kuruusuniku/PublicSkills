// Stream Deck 互換の WebSocket プロトコル (SDK を使わずに直接話す)。
// VSD Craft (VSDinside / MiraBox の Stream Dock) はこのプロトコルでプラグインを動かす。
//   起動: node plugin.js -port <port> -pluginUUID <uuid> -registerEvent <event> -info <json>
//   受信: willAppear / willDisappear / didReceiveSettings / keyDown / keyUp ...
//   送信: { event: "setImage", context, payload: { image, target } } / { event: "showAlert", context }
import type { DeckController, KeySink } from "./deck-controller.ts";
import { parseSlot } from "./deck-controller.ts";
import type { Logger } from "./types.ts";

export const TAB_ACTION_UUID = "com.kuruusuniku.herdr-deck.tab";

export interface RegistrationArgs {
  port: string;
  pluginUUID: string;
  registerEvent: string;
  info: unknown;
}

export function parseRegistrationArgs(argv: string[]): RegistrationArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const port = get("-port");
  const pluginUUID = get("-pluginUUID");
  const registerEvent = get("-registerEvent");
  const infoRaw = get("-info");
  const missing = [
    ["-port", port],
    ["-pluginUUID", pluginUUID],
    ["-registerEvent", registerEvent],
  ].filter(([, v]) => !v);
  if (missing.length) throw new Error(`起動引数が足りません: ${missing.map(([k]) => k).join(", ")}`);
  let info: unknown = null;
  try {
    info = infoRaw ? JSON.parse(infoRaw) : null;
  } catch {
    info = null;
  }
  return { port: port!, pluginUUID: pluginUUID!, registerEvent: registerEvent!, info };
}

export function protocolSink(send: (message: object) => void): KeySink {
  return {
    setImage(context, image) {
      send({ event: "setImage", context, payload: { image, target: 0 } });
    },
    showAlert(context) {
      send({ event: "showAlert", context });
    },
  };
}

interface IncomingMessage {
  event?: string;
  action?: string;
  context?: string;
  device?: string;
  payload?: {
    settings?: { slot?: unknown };
    coordinates?: { column?: number; row?: number };
  };
}

/** アプリから届いたメッセージをボタンの操作に振り分ける */
export async function handleMessage(controller: DeckController, raw: unknown, logger: Logger): Promise<void> {
  const msg = raw as IncomingMessage;
  if (!msg || typeof msg !== "object" || !msg.event) return;
  // VSD Craft は manifest の UUID を大文字小文字そのままで送ってくるので、比較は小文字で
  if (!msg.action || msg.action.toLowerCase() !== TAB_ACTION_UUID || !msg.context) return;
  const id = msg.context;
  switch (msg.event) {
    case "willAppear":
      controller.keyAppear({
        id,
        device: msg.device ?? "",
        column: msg.payload?.coordinates?.column,
        row: msg.payload?.coordinates?.row,
        slot: parseSlot(msg.payload?.settings?.slot),
      });
      break;
    case "willDisappear":
      controller.keyDisappear(id);
      break;
    case "didReceiveSettings":
      controller.keySettings(id, parseSlot(msg.payload?.settings?.slot));
      break;
    case "keyDown":
      controller.keyDown(id);
      break;
    case "keyUp":
      await controller.keyUp(id);
      break;
    default:
      logger.debug(`未対応のイベント: ${msg.event}`);
  }
}
