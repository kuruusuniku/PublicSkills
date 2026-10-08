import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger, NarrationKind } from "./types.ts";
import { silentLogger } from "./types.ts";

export interface DeckConfig {
  herdr: {
    /** herdr バイナリの絶対パス。null なら PATH と既定のインストール先から探す */
    path: string | null;
    /** 名前付きセッションを使う場合のセッション名 (HERDR_SESSION として渡す) */
    session: string | null;
    pollMs: number;
    timeoutMs: number;
  };
  deck: {
    /** "all" = 全タブをボタンに割り当てる / "agents" = エージェントがいるタブだけ */
    tabs: "all" | "agents";
    animation: boolean;
    frameMs: number;
    /** ボタンを押したときに前面に出すアプリ名 (macOS: "WezTerm" "Ghostty" "iTerm" など)。null なら何もしない */
    activateApp: string | null;
    /**
     * ボタン画像の渡し方。"auto" = Stream Deck は svg-base64 / VSD Craft は svg-raw。
     * VSD でボタンが真っ黒・空白のままなら、もう一方を試す
     */
    imageFormat: "auto" | "svg-base64" | "svg-raw";
  };
  voice: {
    enabled: boolean;
    /** 自動で読み上げる出来事 ("done" = 完了, "blocked" = 確認待ち) */
    announce: Exclude<NarrationKind, "status">[];
    /** herdr でいまフォーカスしているペインの完了は読み上げない */
    skipFocused: boolean;
    /** 読み上げの頭に「<ワークスペース名>、」を付ける */
    prefix: boolean;
    cooldownMs: number;
    voicevox: {
      url: string;
      /** VOICEVOX のスタイルID。3 = ずんだもん(ノーマル) */
      speaker: number;
      speedScale: number;
      pitchScale: number;
      intonationScale: number;
      volumeScale: number;
      timeoutMs: number;
    };
    /** 再生コマンド。{file} が WAV のパスに置き換わる。null ならOSごとの既定 */
    player: string[] | null;
    /** VOICEVOX が使えないとき、macOS の say コマンドで代わりに読み上げる */
    fallbackSay: boolean;
  };
  llm: {
    enabled: boolean;
    /** OpenAI 互換 API のベースURL (Ollama: http://127.0.0.1:11434/v1, LM Studio: http://127.0.0.1:1234/v1) */
    baseUrl: string;
    model: string;
    apiKey: string | null;
    timeoutMs: number;
    /** 読み上げ文の最大文字数 */
    maxChars: number;
    /** LLM に渡す画面の行数 */
    screenLines: number;
    temperature: number;
  };
}

export const DEFAULT_CONFIG: DeckConfig = {
  herdr: { path: null, session: null, pollMs: 1200, timeoutMs: 5000 },
  deck: { tabs: "all", animation: true, frameMs: 300, activateApp: null, imageFormat: "auto" },
  voice: {
    enabled: true,
    announce: ["done", "blocked"],
    skipFocused: false,
    prefix: true,
    cooldownMs: 8000,
    voicevox: {
      url: "http://127.0.0.1:50021",
      speaker: 3,
      speedScale: 1.15,
      pitchScale: 0,
      intonationScale: 1,
      volumeScale: 1,
      timeoutMs: 20000,
    },
    player: null,
    fallbackSay: true,
  },
  llm: {
    enabled: true,
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "gemma3:4b",
    apiKey: null,
    timeoutMs: 30000,
    maxChars: 110,
    screenLines: 120,
    temperature: 0.4,
  },
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.HERDR_DECK_CONFIG) return env.HERDR_DECK_CONFIG;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "herdr-deck", "config.json");
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "herdr-deck", "config.json");
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 既定値にユーザー設定を重ねる。型が既定値と食い違う値は捨てて警告する
 * (設定ファイルの typo でプラグイン全体が止まらないようにするため)。
 */
export function mergeConfig(user: unknown, logger: Logger = silentLogger): DeckConfig {
  const warn = (path: string, why: string) => logger.warn(`config: ${path} を無視しました (${why})`);
  const merge = (base: Plain, over: unknown, path: string): Plain => {
    const out: Plain = { ...base };
    if (over === undefined) return out;
    if (!isPlain(over)) {
      warn(path || "(root)", "オブジェクトではありません");
      return out;
    }
    for (const [key, value] of Object.entries(over)) {
      const p = path ? `${path}.${key}` : key;
      if (key.startsWith("$") || key.startsWith("//")) continue;
      if (!(key in base)) {
        warn(p, "未知のキー");
        continue;
      }
      const def = base[key];
      if (isPlain(def)) {
        out[key] = merge(def, value, p);
      } else if (def === null) {
        // null が既定のキーは「文字列 or null」か「文字列配列 or null」
        const ok =
          value === null ||
          typeof value === "string" ||
          (Array.isArray(value) && value.every((x) => typeof x === "string"));
        if (ok) out[key] = value;
        else warn(p, "文字列か null を指定してください");
      } else if (Array.isArray(def)) {
        if (Array.isArray(value)) out[key] = value;
        else warn(p, "配列を指定してください");
      } else if (typeof def === typeof value) {
        out[key] = value;
      } else {
        warn(p, `${typeof def} を指定してください`);
      }
    }
    return out;
  };
  const cfg = merge(structuredClone(DEFAULT_CONFIG) as unknown as Plain, user, "") as unknown as DeckConfig;

  if (cfg.deck.tabs !== "all" && cfg.deck.tabs !== "agents") {
    warn("deck.tabs", '"all" か "agents"');
    cfg.deck.tabs = DEFAULT_CONFIG.deck.tabs;
  }
  if (!["auto", "svg-base64", "svg-raw"].includes(cfg.deck.imageFormat)) {
    warn("deck.imageFormat", '"auto" / "svg-base64" / "svg-raw"');
    cfg.deck.imageFormat = DEFAULT_CONFIG.deck.imageFormat;
  }
  cfg.voice.announce = cfg.voice.announce.filter((k): k is "done" | "blocked" => k === "done" || k === "blocked");
  cfg.herdr.pollMs = Math.max(300, cfg.herdr.pollMs);
  cfg.deck.frameMs = Math.max(100, cfg.deck.frameMs);
  cfg.llm.baseUrl = cfg.llm.baseUrl.replace(/\/+$/, "");
  cfg.voice.voicevox.url = cfg.voice.voicevox.url.replace(/\/+$/, "");
  return cfg;
}

/**
 * 設定ファイルを読み、更新時刻が変わったら読み直す。
 * プラグイン動作中に config.json を書き換えれば、再起動なしで反映される。
 */
export class ConfigStore {
  readonly path: string;
  #logger: Logger;
  #mtimeMs = -1;
  #config: DeckConfig = mergeConfig(undefined);

  constructor(path: string = defaultConfigPath(), logger: Logger = silentLogger) {
    this.path = path;
    this.#logger = logger;
  }

  get(): DeckConfig {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      mtimeMs = 0; // ファイルなし → 既定値
    }
    if (mtimeMs !== this.#mtimeMs) {
      this.#mtimeMs = mtimeMs;
      this.#config = mtimeMs === 0 ? mergeConfig(undefined) : this.#read();
    }
    return this.#config;
  }

  #read(): DeckConfig {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      this.#logger.info(`config: ${this.path} を読み込みました`);
      return mergeConfig(raw, this.#logger);
    } catch (err) {
      this.#logger.error(`config: ${this.path} を読めません (${(err as Error).message})。既定値で動きます`);
      return mergeConfig(undefined);
    }
  }

  /** 設定ファイルが無ければ既定値で作る。作ったら true */
  ensureFile(): boolean {
    try {
      statSync(this.path);
      return false;
    } catch {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
      return true;
    }
  }
}
