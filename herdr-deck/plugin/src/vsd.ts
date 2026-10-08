// VSD Craft (VSDinside / MiraBox の Stream Dock) 用のエントリ。
// Elgato の公式 SDK は Stream Deck 7.1 未満で起動を拒むので使わず、同じ WebSocket プロトコルを直接話す。
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { format } from "node:util";
import WebSocket from "ws";
import { defaultConfigPath } from "./core/config.ts";
import { startRuntime } from "./core/runtime.ts";
import { handleMessage, parseRegistrationArgs, protocolSink } from "./core/sd-protocol.ts";
import type { Logger } from "./core/types.ts";

// ログは設定ファイルと同じ場所 (~/.config/herdr-deck/vsd-plugin.log) に書く
const logFile = join(dirname(defaultConfigPath()), "vsd-plugin.log");
try {
  mkdirSync(dirname(logFile), { recursive: true });
  if (statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
} catch {
  // まだ無い
}
const write = (level: string, args: unknown[]) => {
  const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    // ログが書けなくても動き続ける
  }
};
const logger: Logger = {
  debug: (...a) => (process.env.HERDR_DECK_DEBUG ? write("DEBUG", a) : undefined),
  info: (...a) => write("INFO", a),
  warn: (...a) => write("WARN", a),
  error: (...a) => write("ERROR", a),
};
process.on("uncaughtException", (err) => logger.error("uncaughtException", err));
process.on("unhandledRejection", (err) => logger.error("unhandledRejection", err));

const args = parseRegistrationArgs(process.argv);
logger.info(`起動: node ${process.version} / pid ${process.pid} / port ${args.port}`);

const socket = new WebSocket(`ws://127.0.0.1:${args.port}`);
const send = (message: object) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

const runtime = startRuntime({ logger, sink: protocolSink(send), defaultImageFormat: "svg-raw" });

socket.on("open", () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  logger.info("VSD Craft に接続しました");
  runtime.start();
});
socket.on("message", (data) => {
  let msg: unknown;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return;
  }
  logger.debug("受信", String(data).slice(0, 300));
  handleMessage(runtime.controller, msg, logger).catch((err) => logger.error("イベント処理に失敗", err));
});
socket.on("error", (err) => logger.error("WebSocket エラー", err));
socket.on("close", () => {
  logger.info("VSD Craft との接続が切れたので終了します");
  runtime.stop();
  process.exit(0);
});
