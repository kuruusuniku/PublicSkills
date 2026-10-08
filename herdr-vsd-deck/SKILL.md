---
name: herdr-vsd-deck
description: "herdr で動かしている Claude Code などのエージェントの状態を、VSD Craft (VSDinside / Mirabox Stream Dock) のキーに色とドット絵で表示し、押すとそのターミナルへジャンプ。作業完了や許可待ちはローカルLLMで要約して VOICEVOX のずんだもんが読み上げる。その環境のセットアップ・設定変更・トラブルシュートを行う。"
---

# herdr-vsd-deck

SIOS Tech Lab の記事「オレのClaude Code作業環境、控えめにいって最高すぎる〜Stream Deckでherdrを操作、完了はずんだもんが読み上げ〜」と同じ環境を、
Elgato Stream Deck ではなく **VSD Craft で動く Stream Dock 系デバイス**で作るための skill。

## 全体像

```
                      ┌──────────── VSD Craft (組み込み Node 20) ────────────┐
Claude Code ─画面検出→ herdr ← herdr api snapshot (1秒ごと) ─ herdr Deck プラグイン ─→ キー画像
 (herdr のペイン内)      ↑                                        │
                       └─ herdr agent focus <pane> ←── キー押下 ─┘ + ターミナルを最前面へ
     │
     └─ Stop / Notification フック → zunda_notify.py → ローカルLLM(要約) → VOICEVOX(ずんだもん) → 再生
```

| 部品 | 場所 | 役割 |
|---|---|---|
| VSD Craft プラグイン | `plugin/com.kuruusuniku.herdr-deck.sdPlugin/` | 依存ゼロの Node。npm install 不要 |
| 読み上げフック | `voice/zunda_notify.py` | 標準ライブラリのみの Python |
| インストーラ | `install.py` | プラグイン配置・フック登録・設定雛形 |
| 設定 | `~/.config/herdr-vsd-deck/config.json` | プラグインとフックで共有。雛形は `config.example.json` |

### キーの見え方

| 状態 (herdr) | 色 | ドット絵の羊 | 意味 |
|---|---|---|---|
| `blocked` 確認待ち | 黄 (枠が点滅) | 頭上の「!」が点滅 | 許可や質問への回答待ち |
| `working` 作業中 | 青 | 走っている | 作業中 |
| `done` 完了 | 緑 | 跳ねてキラキラ | 終わったがまだ見ていない (押すと既読→待機) |
| `idle` 待機 | 灰 | 寝ている | 何もしていない |

- **herdr エージェント** アクション: 置いたキーの位置順 (左上から右へ、次の行へ) に1体ずつ割り当てる。
  割り当ては固定 (sticky) で、エージェントが終了すると空き、次の新しいエージェントがそこに入る。
  上段にワークスペース名 (同じワークスペースに複数いればタブ名付き)、下段にタスク名 (Claude Code の端末タイトル) と経過時間
- **herdr サマリー** アクション: 確認待ち/作業中/完了/待機の数。押すと 確認待ち → 完了 → 作業中 の順で一番急ぎのエージェントへ。
  ノブ付きデバイス (N4 など) のノブに置くと、回して選択・押してジャンプ (記事の Stream Deck Neo の情報バーに相当)
- 押すと `herdr agent focus` で herdr 内のペインを切り替え、herdr クライアントを表示しているターミナル
  (Ghostty / iTerm2 / WezTerm / Windows Terminal など) を最前面に出す。別デスクトップ (Space) にあっても切り替わる

## 進め方

この skill はデバイスをつないでいる **macOS / Windows のマシン上で** 動かす。
リモートのクラウド環境からは VSD Craft にも音声にも触れないので、その場合は手順を案内するだけにする。

### Phase 1: 前提の確認

次を実際にコマンドで確認し、足りないものはユーザーに入れてもらう (勝手にインストールしない)。

| 必要なもの | 確認 | 無い場合 |
|---|---|---|
| VSD Craft 3.10.191 以降 | アプリの「バージョン情報」 | 公式サイトから更新。古いと組み込み Node が無くプラグインが起動しない |
| herdr | `herdr --version` | `brew install herdr` / `curl -fsSL https://herdr.dev/install.sh \| sh` / Windows は `irm https://herdr.dev/install.ps1 \| iex` |
| Python 3.9+ | `python3 --version` (Windows は `py -3 --version`) | 読み上げを使わないなら不要 |
| VOICEVOX | `curl -s http://127.0.0.1:50021/version` | VOICEVOX を起動 (エンジンだけでも可)。無ければ OS の読み上げで代用 |
| ローカル LLM (任意) | `ollama list` | `ollama pull gemma3:4b`。無くても定型文で読み上げる |

### Phase 2: インストール

```bash
python3 <この skill のディレクトリ>/install.py
```

- VSD Craft のプラグインフォルダを自動検出する
  (macOS: `~/Library/Application Support/HotSpot/StreamDock/plugins`、Windows: `%APPDATA%\HotSpot\StreamDock\plugins`)。
  見つからなければ VSD Craft の 設定 → 一般 →「アプリケーションフォルダを開く」(英語 UI では Open the application folder) で場所を確認し `--plugins-dir` で渡す
- `~/.claude/settings.json` は書き換える前に `settings.json.bak-herdr-vsd-deck-<日時>` へバックアップされる。
  既存のフックは残し、このフックだけを `Stop` と `Notification` に `async: true` で追加する (再実行しても重複しない)
- キー表示だけなら `--skip-voice`、読み上げだけなら `--skip-plugin`。外すときは `--uninstall`

### Phase 3: デバイスに置く

1. VSD Craft を再起動 (終了して起動し直す)
2. アクション一覧の **herdr Deck** から「herdr エージェント」を並べたいキーへ (例: 1段目すべて)、
   「herdr サマリー」を1つ (ノブがあればノブにも) ドラッグ
3. herdr を起動し、その中のペインで Claude Code を動かす。状態は herdr が画面から検出する
   (`herdr integration install claude` を入れると herdr 再起動後のセッション復元もできる。表示には必須ではない)

### Phase 4: 動作確認

```bash
HOOK=~/.claude/hooks/herdr-vsd-deck/zunda_notify.py
python3 $HOOK --check                     # VOICEVOX と LLM への接続
python3 $HOOK --say "準備できたのだ"         # 実際に声が出るか
echo '{"hook_event_name":"Stop","cwd":"'"$PWD"'","last_assistant_message":"READMEを更新しました"}' \
  | python3 $HOOK --dry-run               # LLM が作る文面だけ確認
herdr api snapshot | head -c 300          # プラグインが読むのと同じ情報
```

キーが「herdr 未接続」「herdr が見つかりません」のままなら下のトラブルシュートへ。
プラグインのログは `<plugins>/com.kuruusuniku.herdr-deck.sdPlugin/plugin/log/plugin.log`。

### Phase 5: 好みに合わせて設定

`~/.config/herdr-vsd-deck/config.json` を編集する。プラグインは保存すると自動で読み直す (再起動不要)。

| キー | 既定 | 説明 |
|---|---|---|
| `herdr.bin` | `""` | herdr のパス。空なら PATH と既定のインストール先を探す |
| `herdr.session` | `""` | `herdr --session <名前>` で使っている場合の名前 |
| `deck.terminalApp` | `""` | 前面に出すアプリ (macOS: `Ghostty` などアプリ名、Windows: `WindowsTerminal` などプロセス名)。空なら herdr クライアントの親プロセスから自動検出 |
| `deck.order` | `"sticky"` | `priority` にすると毎回 確認待ち→完了→作業中→待機 の順に詰める |
| `deck.animate` / `deck.frameMs` | `true` / `500` | アニメーションの有無とコマ送り間隔 (ms)。古いデバイスで重いなら `false` か大きめに |
| `deck.pollMs` | `1000` | herdr を見に行く間隔 (ms) |
| `voice.enabled` | `true` | 読み上げ全体のオンオフ (一時的には環境変数 `HERDR_VSD_DECK_MUTE=1`) |
| `voice.events` | stop/permission/question: `true`, idle: `false` | どの出来事を読み上げるか |
| `voice.speaker` | `3` | VOICEVOX の話者 ID。ずんだもん: ノーマル3 / あまあま1 / ツンツン7 / セクシー5 / ささやき22 / ヒソヒソ38 |
| `voice.speedScale` | `1.15` | 話す速さ |
| `voice.maxChars` | `90` | 読み上げ文の最大文字数 |
| `voice.llm.provider` | `"ollama"` | `ollama` / `openai` (LM Studio・llama.cpp など OpenAI 互換) / `none` (定型文のみ) |
| `voice.llm.model` | `"gemma3:4b"` | 日本語が書ける小さめのモデルが向く (例: `qwen3:4b`, `gemma3:4b`) |
| `voice.fallbackTts` | `true` | VOICEVOX が無いとき OS の読み上げ (macOS `say`、Windows System.Speech) を使う |

## トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| アクション一覧に herdr Deck が無い | VSD Craft を完全に終了して起動し直す。プラグインフォルダの場所が違う可能性 → `--plugins-dir` で再インストール |
| キーが真っ黒・アイコンのまま | VSD Craft が古く組み込み Node が無い。3.10.191 以降へ更新。ログ (`plugin/log/plugin.log`) が作られているか確認 |
| 「herdr が見つかりません」 | GUI アプリには shell の PATH が渡らない。`which herdr` の結果を `herdr.bin` に書く |
| 「herdr 未接続」 | herdr が起動していない。名前付きセッションなら `herdr.session`、`XDG_CONFIG_HOME` を変えているなら `herdr.socketPath` (`<config>/herdr/herdr.sock`) を設定 |
| 押しても herdr は切り替わるがターミナルが前に来ない | 自動検出に失敗。`deck.terminalApp` を指定。macOS は「システム設定 → デスクトップと Dock → アプリケーションの切り替えで…ウインドウがある操作スペースに移動」をオンに |
| 完了(緑)が消えない | herdr の「既読」はキー押下か `herdr agent focus` で付く。キーを押せば待機に戻る |
| 声が出ない | `--check` で VOICEVOX / LLM を確認。Claude Code 側は `/hooks` でフックが見えているか、`claude --debug` でフックのエラーを確認 |
| 読み上げ文が変・遅い | `voice.llm.model` を変える。速さ優先なら `provider: "none"` で定型文 |
| 同時に複数終わると? | 再生は1つずつ順番に行う (ロックで直列化) |

## 注意

- 読み上げにはエージェントの最終発言 (要約前の本文) をローカル LLM に渡す。外部に送らないよう、
  `voice.llm.url` はローカル (127.0.0.1) のままにしておく
- VOICEVOX の音声を公開・配布するときは「VOICEVOX:ずんだもん」のクレジット表記が必要 (個人で聞くだけなら不要)
- テスト: `bash tests/run-tests.sh` (Node 20+ と Python 3。VSD Craft / herdr / VOICEVOX は偽物で代用)
