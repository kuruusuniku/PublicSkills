import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { augmentedPath, findExecutable } from "./herdr.ts";

function run(file: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, env: { ...process.env, PATH: augmentedPath() } }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** OS ごとの既定の WAV 再生コマンド。{file} が WAV のパスになる */
export function defaultPlayer(platform = process.platform, searchPath = augmentedPath()): string[] | null {
  if (platform === "darwin") return ["afplay", "{file}"];
  if (platform === "win32") {
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(New-Object System.Media.SoundPlayer $args[0]).PlaySync()",
      "{file}",
    ];
  }
  const candidates: string[][] = [
    ["paplay", "{file}"],
    ["pw-play", "{file}"],
    ["aplay", "-q", "{file}"],
    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "{file}"],
  ];
  for (const c of candidates) {
    if (findExecutable(c[0], searchPath, platform)) return c;
  }
  return null;
}

/** WAV を一時ファイルに書いて再生し、終わったら消す */
export async function playWav(wav: Buffer, player: string[] | null): Promise<void> {
  const cmd = player ?? defaultPlayer();
  if (!cmd || cmd.length === 0) throw new Error("WAV を再生できるコマンドが見つかりません (config.json の voice.player を設定してください)");
  const file = join(tmpdir(), `herdr-deck-${randomUUID()}.wav`);
  await writeFile(file, wav);
  try {
    const args = cmd.slice(1).map((a) => a.replaceAll("{file}", file));
    if (!cmd.slice(1).some((a) => a.includes("{file}"))) args.push(file);
    await run(cmd[0], args);
  } finally {
    await rm(file, { force: true });
  }
}

/** VOICEVOX が動いていないときの代わり (macOS の say)。他の OS では何もしない */
export async function sayFallback(text: string, platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return false;
  try {
    await run("say", ["-v", "Kyoko", text]);
    return true;
  } catch {
    try {
      await run("say", [text]);
      return true;
    } catch {
      return false;
    }
  }
}
