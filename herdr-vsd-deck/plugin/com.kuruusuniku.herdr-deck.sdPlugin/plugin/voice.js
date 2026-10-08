'use strict';

// エージェントの作業が終わったとき・確認待ちになったときに、その画面をローカル LLM で読み上げ文にして
// VOICEVOX のずんだもんに読ませる (SIOS Tech Lab の記事の「ステップ 3」と同じ仕組み)。
//
//   きっかけ: ペインの状態が working → done / working → idle (= 作業が終わった)、または → blocked (= 確認待ち)
//            done → idle は「見た」だけなので読まない。プラグイン起動直後 (前回の状態が無い) も読まない
//   流れ:     herdr pane read (直近 200 行) → LLM (Chat Completions) → VOICEVOX → 再生
//            文の頭に「<スペース名>から。」を付ける
//   その他:   1件ずつ順番に読む。3件より多く溜まったら古いものから捨てる。同じ画面は二度読まない
//            VOICEVOX か LLM が応答しなければ、何も通知せずその回を飛ばす (理由はログにだけ残す)

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const QUEUE_MAX = 3;
const PROBE_MS = 1500;

const SYSTEM_PROMPT = `あなたは「ずんだもん」です。画面を見ていない開発者に、AI コーディングエージェントの作業状況を声で伝えます。

入力はターミナルの画面をそのまま写したものです。枠線や記号 (❯ ⏺ ⎿ ▎ ─ │ など)、入力欄、ステータス行、途中で切れた行は無視して、中身だけを読み取ってください。
❯ で始まる行がユーザーの依頼、⏺ で始まる行がエージェントの返答で、一番下が最新です。

聞き手が「次に自分が何をすればいいか」を分かることを最優先にしてください。要約ではありません。
- 作業が終わったとき: 何をしたか → その結果どうなったか → 次にユーザーがすべきこと (質問や選択肢があればその中身) を 3 文で。
- 確認待ちのとき: 今何の作業の途中か → 何の許可を求めているのか・何を質問しているのか → どう答えればいいか を 3 文で。
  削除や上書きなど取り消しにくい操作は必ず言うこと。選択肢は読み上げるが、どれを選ぶべきかは勧めないこと。

すべての文を「〜のだ」「〜なのだ」で終えてください。前置き、敬語、箇条書き、記号、絵文字は使わないこと。
コマンドやファイルパスはそのまま読まずに、何をするものかの言葉に言い換えること。全体で 120 文字以内。

例 (作業が終わったとき):
ログイン画面の入力チェックを直したのだ。テストは全部通ったのだ。差分を見てコミットするか決めてほしいのだ。
例 (確認待ちのとき):
ビルド設定を直す作業の途中なのだ。古い出力フォルダを削除するコマンドの許可を求めているのだ。許可する、今後も聞かずに許可する、やめて指示し直す、のどれかを選んでほしいのだ。
例 (作業が終わって質問しているとき):
データ移行の手順書を書き上げたのだ。本番の手順は二通り考えたのだ。止めて移すか、動かしたまま移すかを答えてほしいのだ。`;

function sanitize(text, maxChars = 120) {
  let out = String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>|~[\]「」『』"“”]/g, '')
    .replace(/\s*\n\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    out = end >= 0 ? cut.slice(0, end + 1) : `${cut.replace(/、$/, '')}。`;
  }
  return out;
}

// ペインごとの状態の変化から、読み上げるべき出来事を拾う
function detectEvents(previous, panes) {
  const events = [];
  for (const pane of panes) {
    const before = previous.get(pane.paneId);
    if (before === undefined) continue; // 初めて見たペイン (起動直後を含む) は読まない
    if (before === 'working' && (pane.status === 'done' || pane.status === 'idle')) events.push({ paneId: pane.paneId, kind: 'finished' });
    else if (pane.status === 'blocked' && before !== 'blocked') events.push({ paneId: pane.paneId, kind: 'waiting' });
  }
  return events;
}

function playerCommand(file, platform = process.platform) {
  if (platform === 'darwin') return ['afplay', [file]];
  if (platform === 'win32') {
    const script = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
  }
  return ['paplay', [file]];
}

function playWav(wav) {
  const file = path.join(os.tmpdir(), `herdr-deck-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);
  const [cmd, args] = playerCommand(file);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, windowsHide: true }, (err) => {
      fs.rm(file, { force: true }, () => {});
      if (err) reject(err);
      else resolve();
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Voice {
  constructor({ config, herdr, log = () => {}, isMuted = () => false, fetchImpl = globalThis.fetch, play = playWav, retryMs = 700 } = {}) {
    this.config = config; // () => cfg.voice
    this.herdr = herdr; // () => HerdrCli
    this.log = log;
    this.isMuted = isMuted;
    this.fetch = fetchImpl;
    this.play = play;
    this.retryMs = retryMs;
    this.previous = null; // paneId -> status
    this.spaceOf = new Map(); // paneId -> スペース名
    this.lastScreen = new Map(); // paneId -> 画面のハッシュ
    this.queue = [];
    this.busy = null;
  }

  // refresh のたびに呼ぶ。読み上げは裏で順番に進める
  observe(model) {
    for (const space of model.spaces) for (const tab of space.tabs) for (const pane of tab.panes) this.spaceOf.set(pane.paneId, space.label);
    const events = this.previous ? detectEvents(this.previous, model.panes) : [];
    this.previous = new Map(model.panes.map((p) => [p.paneId, p.status]));
    const cfg = this.config();
    if (!cfg.enabled || cfg.source === 'hooks') return events;
    for (const event of events) this.enqueue({ ...event, space: this.spaceOf.get(event.paneId) || '' });
    return events;
  }

  enqueue(item) {
    this.queue.push(item);
    while (this.queue.length > QUEUE_MAX) {
      const dropped = this.queue.shift();
      this.log(`voice: 溜まりすぎたので捨てた ${dropped.paneId}`);
    }
    if (!this.busy) this.busy = this.drain().finally(() => { this.busy = null; });
  }

  async drain() {
    while (this.queue.length) {
      const item = this.queue.shift();
      try {
        await this.announce(item);
      } catch (err) {
        this.log(`voice: ${item.paneId} を読めなかった: ${err.message}`);
      }
    }
  }

  async probe(url) {
    try {
      const res = await this.fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async readScreen(paneId) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const text = await this.herdr().readPane(paneId, 200);
        if (text.trim()) return text;
      } catch (err) {
        lastErr = err;
      }
      await sleep(this.retryMs);
    }
    throw lastErr || new Error('画面が空');
  }

  async compose(cfg, kind, screen) {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.llmApiKey) headers.Authorization = `Bearer ${cfg.llmApiKey}`;
    const situation = kind === 'waiting' ? '確認待ち (エージェントがユーザーの許可や回答を待って止まっている)' : '作業が終わった';
    const res = await this.fetch(`${cfg.llmUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `状況: ${situation}\n\n画面:\n${screen.slice(-12000)}` },
        ],
        reasoning_effort: 'none', // thinking で出力を使い切らないように
        temperature: 0.3,
        max_tokens: 400,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`LLM が HTTP ${res.status} を返した`);
    const data = await res.json();
    return sanitize(data?.choices?.[0]?.message?.content, cfg.maxChars);
  }

  async synthesize(cfg, text) {
    const base = cfg.voicevoxUrl.replace(/\/$/, '');
    const q = new URLSearchParams({ text, speaker: String(cfg.speaker) });
    const queryRes = await this.fetch(`${base}/audio_query?${q}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (!queryRes.ok) throw new Error(`VOICEVOX audio_query が HTTP ${queryRes.status}`);
    const query = await queryRes.json();
    query.speedScale = Number(cfg.speedScale) || 1;
    const synth = await this.fetch(`${base}/synthesis?speaker=${encodeURIComponent(cfg.speaker)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(60000),
    });
    if (!synth.ok) throw new Error(`VOICEVOX synthesis が HTTP ${synth.status}`);
    return Buffer.from(await synth.arrayBuffer());
  }

  async announce({ paneId, kind, space }) {
    const cfg = this.config();
    if (!cfg.enabled || this.isMuted()) {
      this.log(`voice: ${paneId} はミュート中なので読まない`);
      return null;
    }
    const base = cfg.llmUrl.replace(/\/$/, '');
    const [voicevoxUp, llmUp] = await Promise.all([this.probe(`${cfg.voicevoxUrl.replace(/\/$/, '')}/version`), this.probe(`${base}/models`)]);
    if (!voicevoxUp || !llmUp) {
      this.log(`voice: ${!voicevoxUp ? 'VOICEVOX' : 'LLM'} が応答しないので ${paneId} は飛ばした`);
      return null;
    }
    const screen = await this.readScreen(paneId);
    const digest = crypto.createHash('sha1').update(screen).digest('hex');
    if (this.lastScreen.get(paneId) === digest) {
      this.log(`voice: ${paneId} は同じ画面なので読まない`);
      return null;
    }
    this.lastScreen.set(paneId, digest);
    const body = await this.compose(cfg, kind, screen);
    if (!body) {
      this.log(`voice: ${paneId} の読み上げ文が空だった`);
      return null;
    }
    const sentence = space ? `${space}から。${body}` : body;
    await this.play(await this.synthesize(cfg, sentence));
    this.log(`voice: ${kind === 'waiting' ? '確認待ち' : '完了'} ${paneId}: ${sentence}`);
    return sentence;
  }
}

module.exports = { Voice, detectEvents, sanitize, playerCommand, SYSTEM_PROMPT, QUEUE_MAX };
