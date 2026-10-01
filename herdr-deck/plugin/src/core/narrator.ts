import type { ConfigStore } from "./config.ts";
import type { HerdrClient } from "./herdr.ts";
import type { FetchLike } from "./llm.ts";
import { cleanForSpeech, fallbackText, prepareScreen, spokenPlace, summarize } from "./llm.ts";
import { playWav, sayFallback } from "./player.ts";
import type { Logger, NarrationEvent } from "./types.ts";
import { synthesize } from "./voicevox.ts";

export interface NarratorDeps {
  config: ConfigStore;
  herdr: Pick<HerdrClient, "readPane">;
  logger: Logger;
  fetch?: FetchLike;
  play?: (wav: Buffer, player: string[] | null) => Promise<void>;
  say?: (text: string) => Promise<boolean>;
}

export interface NarrationResult {
  text: string;
  /** "llm" = ローカルLLMの要約 / "fallback" = 定型文 */
  source: "llm" | "fallback";
  /** "voicevox" / "say" (macOS の代替) / "none" (音を出せなかった) */
  voice: "voicevox" | "say" | "none";
}

const MAX_QUEUE = 4;

/**
 * 画面を読む → ローカル LLM でずんだもん口調に要約 → VOICEVOX で合成 → 再生、を1件ずつ順番に行う。
 * どこかが失敗しても、できるところまでは必ずやる (LLM が落ちていても定型文で読み上げる)。
 */
export class Narrator {
  #deps: NarratorDeps;
  #queue: NarrationEvent[] = [];
  #busy = false;
  #idleWaiters: (() => void)[] = [];

  constructor(deps: NarratorDeps) {
    this.#deps = deps;
  }

  /** 読み上げ待ちに積む。設定で無効なもの・溢れたものは捨てる */
  enqueue(event: NarrationEvent): boolean {
    const cfg = this.#deps.config.get();
    if (!cfg.voice.enabled) return false;
    // 長押しで聞いた (status) ときは、自動読み上げの設定に関係なく答える
    if (event.kind !== "status") {
      if (!cfg.voice.announce.includes(event.kind)) return false;
      if (cfg.voice.skipFocused && event.focused) return false;
    }
    // 同じペインの古い予定は新しいものに置き換える
    this.#queue = this.#queue.filter((q) => q.paneId !== event.paneId);
    if (this.#queue.length >= MAX_QUEUE) {
      const dropped = this.#queue.shift();
      this.#deps.logger.warn(`読み上げが詰まっているので ${dropped?.paneId} を飛ばします`);
    }
    this.#queue.push(event);
    void this.#drain();
    return true;
  }

  /** キューが空になるまで待つ (テスト・CLI 用) */
  idle(): Promise<void> {
    if (!this.#busy && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      let next: NarrationEvent | undefined;
      while ((next = this.#queue.shift())) {
        try {
          await this.narrate(next);
        } catch (err) {
          this.#deps.logger.error(`読み上げに失敗: ${(err as Error).message}`);
        }
      }
    } finally {
      this.#busy = false;
      for (const w of this.#idleWaiters.splice(0)) w();
    }
  }

  /** 1件分の処理 (キューを通さず直接呼んでもよい) */
  async narrate(event: NarrationEvent): Promise<NarrationResult> {
    const cfg = this.#deps.config.get();
    const log = this.#deps.logger;
    let body = fallbackText(event);
    let source: NarrationResult["source"] = "fallback";

    if (cfg.llm.enabled) {
      try {
        const raw = await this.#deps.herdr.readPane(event.paneId, cfg.llm.screenLines);
        const screen = prepareScreen(raw, cfg.llm.screenLines);
        if (screen.trim()) {
          body = await summarize(event, screen, cfg.llm, this.#deps.fetch);
          source = "llm";
        }
      } catch (err) {
        log.warn(`LLM 要約をあきらめて定型文にします: ${(err as Error).message}`);
      }
    }

    const prefix = cfg.voice.prefix ? `${cleanForSpeech(spokenPlace(event), 40)}、` : "";
    const text = prefix + body;
    log.info(`[${event.kind}] ${text}`);
    const voice = await this.speak(text);
    return { text, source, voice };
  }

  /** テキストをそのまま読み上げる */
  async speak(text: string): Promise<NarrationResult["voice"]> {
    const cfg = this.#deps.config.get();
    const log = this.#deps.logger;
    const play = this.#deps.play ?? playWav;
    let wav: Buffer | null = null;
    try {
      wav = await synthesize(text, cfg.voice.voicevox, this.#deps.fetch);
    } catch (err) {
      log.warn(`VOICEVOX で合成できません: ${(err as Error).message}`);
    }
    if (wav) {
      try {
        await play(wav, cfg.voice.player);
        return "voicevox";
      } catch (err) {
        log.warn(`音声を再生できません: ${(err as Error).message}`);
      }
    }
    if (cfg.voice.fallbackSay) {
      const say = this.#deps.say ?? sayFallback;
      if (await say(text)) return "say";
    }
    return "none";
  }
}
