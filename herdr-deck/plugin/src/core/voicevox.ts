import type { DeckConfig } from "./config.ts";
import type { FetchLike } from "./llm.ts";

type VoicevoxConfig = DeckConfig["voice"]["voicevox"];

/** VOICEVOX ENGINE で WAV を作る (audio_query → synthesis) */
export async function synthesize(text: string, cfg: VoicevoxConfig, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  const q = new URLSearchParams({ text, speaker: String(cfg.speaker) });
  const queryRes = await fetchImpl(`${cfg.url}/audio_query?${q}`, { method: "POST", signal });
  if (!queryRes.ok) throw new Error(`VOICEVOX audio_query ${queryRes.status}: ${(await queryRes.text()).slice(0, 200)}`);
  const query = (await queryRes.json()) as Record<string, unknown>;
  query.speedScale = cfg.speedScale;
  query.pitchScale = cfg.pitchScale;
  query.intonationScale = cfg.intonationScale;
  query.volumeScale = cfg.volumeScale;

  const synthRes = await fetchImpl(`${cfg.url}/synthesis?speaker=${cfg.speaker}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/wav" },
    body: JSON.stringify(query),
    signal,
  });
  if (!synthRes.ok) throw new Error(`VOICEVOX synthesis ${synthRes.status}: ${(await synthRes.text()).slice(0, 200)}`);
  const wav = Buffer.from(await synthRes.arrayBuffer());
  if (wav.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("VOICEVOX の応答が WAV ではありません");
  return wav;
}

export interface SpeakerStyle {
  speaker: string;
  style: string;
  id: number;
}

/** doctor 用: 使える話者とスタイルID */
export async function listStyles(cfg: VoicevoxConfig, fetchImpl: FetchLike = fetch): Promise<SpeakerStyle[]> {
  const res = await fetchImpl(`${cfg.url}/speakers`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const speakers = (await res.json()) as { name: string; styles: { name: string; id: number }[] }[];
  return speakers.flatMap((s) => s.styles.map((st) => ({ speaker: s.name, style: st.name, id: st.id })));
}
