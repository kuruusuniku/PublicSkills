import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { SessionSnapshot } from "./types.ts";

/**
 * Stream Deck から起動されたプロセスは、ログインシェルの PATH を引き継がないことが多い
 * (macOS の GUI アプリは /usr/bin:/bin:/usr/sbin:/sbin しか持たない)。
 * herdr の公式インストーラ・Homebrew・cargo・mise・nix の置き場所を補う。
 */
export function extraBinDirs(home: string = homedir(), platform = process.platform): string[] {
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return [
      local ? join(local, "herdr", "bin") : "",
      local ? join(local, "Programs", "herdr") : "",
      join(home, ".local", "bin"),
      join(home, ".cargo", "bin"),
    ].filter(Boolean);
  }
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".cargo", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".nix-profile", "bin"),
    "/run/current-system/sw/bin",
  ];
}

/** PATH に extraBinDirs を足した文字列 (重複は除く) */
export function augmentedPath(current = process.env.PATH ?? "", platform = process.platform): string {
  const parts = current.split(delimiter).filter(Boolean);
  for (const dir of extraBinDirs(homedir(), platform)) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(delimiter);
}

export function findExecutable(name: string, searchPath = augmentedPath(), platform = process.platform): string | null {
  const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
  // パス付きで指定されたらそのファイルだけを見る
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    try {
      accessSync(name, mode);
      return name;
    } catch {
      return null;
    }
  }
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = join(dir, n);
      try {
        accessSync(candidate, mode);
        return candidate;
      } catch {
        // 次へ
      }
    }
  }
  return null;
}

export class HerdrError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface HerdrClientOptions {
  /** herdr バイナリのパス。null なら探す */
  bin: string | null;
  session: string | null;
  timeoutMs: number;
}

export interface CommandRunner {
  (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string }>;
}

export const execRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });

/** herdr CLI の薄いラッパー。すべて `herdr <cmd>` を子プロセスで叩く */
export class HerdrClient {
  #opts: HerdrClientOptions;
  #run: CommandRunner;
  #resolved: string | null = null;

  constructor(opts: HerdrClientOptions, run: CommandRunner = execRunner) {
    this.#opts = opts;
    this.#run = run;
  }

  /** 設定変更(パス・セッション)を反映する */
  configure(opts: HerdrClientOptions): void {
    if (opts.bin !== this.#opts.bin) this.#resolved = null;
    this.#opts = opts;
  }

  binary(): string {
    if (this.#opts.bin) return this.#opts.bin;
    if (!this.#resolved) {
      const found = findExecutable("herdr");
      if (!found) {
        throw new HerdrError(
          "herdr が見つかりません。config.json の herdr.path にフルパスを書いてください",
          "herdr_not_found",
        );
      }
      this.#resolved = found;
    }
    return this.#resolved;
  }

  async #exec(args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
    if (this.#opts.session) env.HERDR_SESSION = this.#opts.session;
    try {
      const { stdout } = await this.#run(this.binary(), args, { env, timeoutMs: this.#opts.timeoutMs });
      return stdout;
    } catch (err) {
      throw toHerdrError(err, args);
    }
  }

  async #json<T>(args: string[]): Promise<T> {
    const out = await this.#exec(args);
    let parsed: { result?: T; error?: { code?: string; message?: string } };
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new HerdrError(`herdr ${args.join(" ")} の出力がJSONではありません`, "bad_output");
    }
    if (parsed.error) throw new HerdrError(parsed.error.message ?? "herdr error", parsed.error.code ?? "error");
    if (!parsed.result) throw new HerdrError(`herdr ${args.join(" ")} に result がありません`, "bad_output");
    return parsed.result;
  }

  async snapshot(): Promise<SessionSnapshot> {
    const result = await this.#json<{ type: string; snapshot: SessionSnapshot }>(["api", "snapshot"]);
    if (result.type !== "session_snapshot" || !result.snapshot) {
      throw new HerdrError(`想定外のレスポンス: ${result.type}`, "bad_output");
    }
    const s = result.snapshot;
    s.workspaces ??= [];
    s.tabs ??= [];
    s.agents ??= [];
    return s;
  }

  /** ペインの画面(直近 lines 行、折り返し解除済み)をプレーンテキストで読む */
  async readPane(paneId: string, lines: number): Promise<string> {
    return this.#exec(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  }

  /** エージェントのいるペインへ移動する。herdr 側で「既読」になり done → idle に戻る */
  async focusAgent(paneId: string): Promise<void> {
    await this.#json(["agent", "focus", paneId]);
  }

  async focusTab(tabId: string): Promise<void> {
    await this.#json(["tab", "focus", tabId]);
  }
}

function toHerdrError(err: unknown, args: string[]): HerdrError {
  if (err instanceof HerdrError) return err;
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
  if (e.code === "ENOENT") return new HerdrError("herdr を起動できません (パスを確認してください)", "herdr_not_found");
  if (e.killed || e.signal === "SIGTERM") return new HerdrError(`herdr ${args[0]} がタイムアウトしました`, "timeout");
  const stderr = (e.stderr ?? "").trim();
  // サーバーエラーは stderr に {"id":..,"error":{"code":..,"message":..}} が出る
  try {
    const parsed = JSON.parse(stderr.split("\n").pop() ?? "");
    if (parsed?.error) return new HerdrError(parsed.error.message ?? "herdr error", parsed.error.code ?? "error");
  } catch {
    // JSON ではない
  }
  const firstLine = stderr.split("\n")[0] || e.message;
  // サーバー未起動: "no herdr server is running at ..." / "failed to connect to server: ..."
  if (/no herdr server|failed to connect|connection refused/i.test(firstLine)) {
    return new HerdrError(`herdr サーバーに接続できません: ${firstLine}`, "server_unavailable");
  }
  return new HerdrError(firstLine, "error");
}
