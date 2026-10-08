---
name: herdr-vsd-deck
description: "SIOS Tech Lab の記事「Stream Deckでherdrを操作、完了はずんだもんが読み上げ」と同じ環境を、VSD Craft (VSDinside / Mirabox Stream Dock、例: VSD M18) で作る。上段に herdr のスペース、下段にそのタブを並べ、タブに住むドット絵のキャラクターでエージェントの状態 (作業中・確認待ち・完了・待機・空席) を表示、押すとそのターミナルへジャンプ。作業が終わる・確認待ちになると、画面をローカルLLMで「何をして→どうなって→次に何をするか」にまとめて VOICEVOX のずんだもんが読み上げる。セットアップ・設定変更・トラブルシュートを行う。"
---

# herdr-vsd-deck

[SIOS Tech Lab の記事](https://tech-lab.sios.jp/archives/54936)「オレのClaude Code作業環境、控えめにいって最高すぎる〜Stream Deckでherdrを操作、完了はずんだもんが読み上げ〜」
の仕組みを、Elgato Stream Deck Neo ではなく **VSD Craft で動く Stream Dock 系デバイス (VSD M18 など)** で再現する skill。
記事の「このプラグインを作ったプロンプト」(ステップ 1〜3) の仕様に沿って実装している。

## 全体像

```
                 ┌──────────────── VSD Craft (組み込み Node 20) ─────────────────┐
Claude Code      │                     herdr Deck プラグイン                      │
 (herdr のタブ)   │  1.2 秒ごとに herdr api snapshot ─→ スペース/タブ/ペインの状態 │ ─→ ボタンの絵 (SVG)
       │         │  ボタンが押されたら herdr workspace/tab focus + ターミナルを前面へ │
       ▼         │  作業中→完了 / →確認待ち を見つけたら                           │
     herdr ─────→│    herdr pane read (直近 200 行) ─→ ローカル LLM (Chat Completions) │
                 │    ─→ VOICEVOX (ずんだもん) ─→ afplay で再生                    │
                 └────────────────────────────────────────────────────────────────┘
```

| 部品 | 場所 | 役割 |
|---|---|---|
| VSD Craft プラグイン | `plugin/com.kuruusuniku.herdr-deck.sdPlugin/` | 依存ゼロの Node。npm install 不要 (M18 の RGB ライトを使う場合だけ node-hid) |
| インストーラ | `install.py` | プラグイン配置・設定雛形。`~/.claude/settings.json` には触らない |
| 設定 | `~/.config/herdr-vsd-deck/config.json` | 雛形は `config.example.json`。保存すればプラグインが自動で読み直す |
| 確認用スクリプト | `voice/zunda_notify.py` | `--check` / `--say` で VOICEVOX と LLM を確認。Claude Code フックで読ませる代替方式も兼ねる |

## ボタン

### 配置 (VSD M18: 縦3 x 横5 + 画面なしボタン3つ)

```
┌────┬────┬────┬────┬────┐
│ S1 │ S2 │ S3 │ S4 │ S5 │   S = herdr スペース (上段)
├────┼────┼────┼────┼────┤
│ T1 │ T2 │ T3 │ T4 │ T5 │   T = herdr タブ (上段で選んだスペースのタブ)
├────┼────┼────┼────┼────┤
│ T6 │ T7 │ T8 │ T9 │T10 │
└────┴────┴────┴────┴────┘
   [急ぎへ]  [次へ]  [ミュート]   画面なしボタン: herdr サマリー / herdr 次へ / 読み上げミュート
```

- 上段のスペースを押すと、そのスペースを選び herdr 側でもフォーカスする。下段がそのスペースのタブに切り替わる
- 下段のタブを押すと、herdr でそのタブに切り替え、herdr が動いているターミナルアプリを前面に出す
  (macOS はアプリを前面に出すと、そのウィンドウがあるデスクトップへ自動で切り替わる)
- 1つのスペースのタブがタブのボタンより多いときは、選択中のスペースをもう一度押すと次のページへ。
  選択中のスペースボタンに `1/2` のように今の位置が出る
- スペースが 6 つ以上あるときは、VSD Craft のページ 2 にスペースのボタンを置き、設定画面で **スロット** を 6〜10 にする。
  スロットを空にしたボタンは、置いた位置の順 (左上から) に 1, 2, 3… を表示する
- herdr 側でスペースを切り替えると、デッキの選択も追従する
- 押したときのチェックマークは出さない。失敗したときだけ警告を出す
- 画面なしボタンは VSD Craft では既定でページ切り替え。複数ページを使うなら 1 つはページ切り替えのまま残す

### ボタンに住むドット絵のキャラクター

| 状態 (herdr) | ボタンの色 | キャラクター |
|---|---|---|
| working (作業中) | 黄 | 机でタイピングしている (汗をかいている) |
| blocked (確認待ち) | 赤 | 手を振って「!」の吹き出しを出している |
| done (完了) | ミント | バンザイして紙吹雪が舞っている |
| idle (待機中) | 青 | 居眠りしている (zzz) |
| エージェントなし | 紫 | 空席 (椅子だけ) |

- タブの状態は、そのタブのペインのうち最も深刻なもの (確認待ち > 作業中 > 完了 > 待機)
- スペースのボタンには、そのスペースのタブにいる住人の顔が並ぶ。スペースに入らなくても確認待ちに気づける
- 選択中のボタン (選んでいるスペースと、herdr でアクティブなタブ) は、背景が状態色の明るい淡い色、文字が濃い紺
- 名前は全角 4 文字で 1 行、最大 2 行。少しはみ出す名前は縮めて 1 行に、長い英単語はハイフンで折り返す
- キャラクターは記事の仕様 (14x12 マス、上の演技) に合わせて独自に描いたもの。M18 の 64x64 ピクセルのキーでにじまないよう、ちょうど 2〜3 倍で描いている

### 画面なしボタン向けのアクション

| アクション | 押すと |
|---|---|
| **herdr サマリー** | 確認待ち → 完了 → 作業中 の順で一番急ぎのタブへ。液晶キーに置けば各状態の数 (2x2) を表示 |
| **herdr 次へ** | 押すたびに急ぎ順で次のタブへ |
| **読み上げミュート** | ずんだもんの読み上げを止める/戻す (会議中などに) |

## ずんだもんの読み上げ

記事の「ステップ 3」と同じ。読み上げは **プラグインが** 行うので、Claude Code 側の設定は要らない。

- きっかけ: タブのペインが 作業中 → 完了、作業中 → 待機 (見ているタブの作業が終わると herdr は完了を経由しない) で「作業が終わった」、
  → 確認待ち で「確認待ち」。完了 → 待機 は「見た」だけなので読まない。プラグイン起動直後も読まない
- 流れ: `herdr pane read <pane> --source recent-unwrapped --lines 200 --format text` (失敗したら間を空けて最大 3 回) →
  ローカル LLM に Chat Completions (`reasoning_effort: "none"`) → VOICEVOX の `/audio_query` と `/synthesis` → `afplay` で再生
- LLM へのお願い: 作業が終わったら「何をしたか → どうなったか → 次にユーザーがすべきこと」、確認待ちなら
  「何の作業中か → 何の許可・質問か → どう答えればいいか」を 3 文で。削除など取り消しにくい操作は必ず言い、
  選択肢は読み上げるがどれを選ぶかは勧めない。語尾は「〜のだ」、120 文字以内
- 文の頭に「<スペース名>から。」を付ける。1 件ずつ順番に読み、3 件より多く溜まったら古いものから捨てる。同じ画面は二度読まない
- VOICEVOX か LLM が応答しないときは、何も通知せずその回を飛ばす (理由はプラグインのログにだけ残す)

## 進め方

この skill はデバイスをつないでいる **macOS (または Windows) のマシン上で** 動かす。
クラウドの環境からは VSD Craft にも音声にも触れないので、その場合は手順を案内するだけにする。

### Phase 1: 前提の確認

次を実際にコマンドで確認し、足りないものはユーザーに入れてもらう (勝手にインストールしない)。

| 必要なもの | 確認 | 無い場合 |
|---|---|---|
| VSD Craft 3.10.191 以降 | アプリの「バージョン情報」 | 公式サイトから更新。組み込み Node が無い古い版でも、Homebrew などの node (`brew install node`) があればそれで起動する |
| herdr | `herdr --version` | `brew install herdr` / `curl -fsSL https://herdr.dev/install.sh \| sh` |
| VOICEVOX | `curl -s http://127.0.0.1:50021/version` | VOICEVOX アプリを起動するか、Docker で `docker run -d -p 50021:50021 voicevox/voicevox_engine:cpu-latest` |
| ローカル LLM | `curl -s http://127.0.0.1:11434/v1/models` | Ollama を入れて `ollama pull qwen3.5:9b` (記事と同じモデル。別のモデルでもよい) |
| Python 3 | `python3 --version` | インストーラと確認用スクリプトに使う (macOS は標準で入っている) |

### Phase 2: インストール

```bash
python3 <この skill のディレクトリ>/install.py --restart
```

- VSD Craft のプラグインフォルダを自動で探してプラグインを置き、`--restart` で VSD Craft を再起動する
  (macOS: `~/Library/Application Support/HotSpot/StreamDock/plugins`)。見つからなければ VSD Craft の
  設定 → 一般 →「アプリケーションフォルダを開く」で場所を確認し `--plugins-dir` で渡す
- M18 の RGB ライトも状態色にするなら `--with-led` (実験的。npm で node-hid を入れる。確認待ち=赤で脈動 / 完了=ミント / 作業中=黄)。
  VSD Craft 側のライト効果はオフにしておく
- 外すときは `--uninstall` (設定ファイルは残す)

### Phase 3: デバイスに置く

1. VSD Craft のアクション一覧の **herdr Deck** から、上段に「herdr スペース」、その下に「herdr タブ」をドラッグ
2. 画面なしボタンに「herdr サマリー」「herdr 次へ」「読み上げミュート」(使うものだけ)
3. herdr を起動し、プロジェクトごとにスペースを作り、タブで Claude Code を動かす。状態は herdr が画面から検出する

### Phase 4: 動作確認

```bash
python3 <skill>/voice/zunda_notify.py --check                  # VOICEVOX と LLM に届くか
python3 <skill>/voice/zunda_notify.py --say "準備できたのだ"    # 声が出るか
herdr api snapshot | head -c 300                               # プラグインが読むのと同じ情報
```

ボタンが「未接続」「見つからず」のままなら下のトラブルシュートへ。
プラグインのログ (押した・読んだ・飛ばした理由) は `<plugins>/com.kuruusuniku.herdr-deck.sdPlugin/plugin/log/plugin.log`。

### Phase 5: 好みに合わせて設定

`~/.config/herdr-vsd-deck/config.json` を編集する。保存すれば再起動なしで反映される。

| キー | 既定 | 説明 |
|---|---|---|
| `herdr.bin` | `""` | herdr のパス。空なら PATH と /opt/homebrew/bin などを探す |
| `herdr.session` | `""` | `herdr --session <名前>` で使っている場合の名前 |
| `deck.terminalApp` | `""` | 前面に出すアプリ (例 `Ghostty`)。空なら herdr のプロセスから親をたどって自動で探す |
| `deck.pollMs` | `1200` | herdr に状態を聞きに行く間隔 (記事と同じ 1.2 秒) |
| `deck.frameMs` / `deck.animate` | `300` / `true` | キャラクターのコマ送り (記事は 150ms)。前回と同じ絵は送らない |
| `deck.ledRing` | `false` | M18 の RGB ライトを状態色にする (実験的) |
| `voice.enabled` | `true` | 読み上げのオン・オフ (一時的には「読み上げミュート」ボタン) |
| `voice.llmUrl` / `voice.llmModel` | `http://127.0.0.1:11434/v1` / `qwen3.5:9b` | OpenAI 互換の Chat Completions。LM Studio などでも可 (`voice.llmApiKey` も設定できる) |
| `voice.voicevoxUrl` / `voice.speaker` | `http://127.0.0.1:50021` / `3` | 話者 ID。ずんだもん: ノーマル3 / あまあま1 / ツンツン7 / セクシー5 / ささやき22 / ヒソヒソ38 |
| `voice.speedScale` / `voice.maxChars` | `1.1` / `120` | 話す速さ / 読み上げ文の最大文字数 |
| `voice.source` | `"deck"` | `hooks` にすると、プラグインは読まず Claude Code のフックで読む (`install.py --with-claude-hooks` が設定) |

## トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| アクション一覧に herdr Deck が無い | VSD Craft を完全に終了して起動し直す。プラグインフォルダの場所が違う可能性 → `--plugins-dir` で入れ直す |
| ボタンが真っ黒・アイコンのまま | VSD Craft が古く組み込み Node が無い → 更新するか `brew install node`。ログ (`plugin/log/plugin.log`) ができているか確認 |
| 「見つからず」 | GUI アプリにはシェルの PATH が渡らない。`which herdr` の結果を `herdr.bin` に書く |
| 「未接続」 | herdr が起動していない。名前付きセッションなら `herdr.session` を設定 |
| herdr は切り替わるがターミナルが前に来ない | `deck.terminalApp` を指定。macOS は「システム設定 → デスクトップと Dock → アプリケーションの切り替えで、そのアプリのウインドウが開いている操作スペースに移動」をオンに |
| 完了 (ミント) が消えない | herdr の「既読」はそのタブに切り替えたときに付く。ボタンを押せば待機に戻る |
| 声が出ない | `zunda_notify.py --check` で VOICEVOX と LLM を確認。ログに「応答しないので飛ばした」「同じ画面なので読まない」などの理由が出る |
| 読み上げが遅い・変 | `voice.llmModel` を軽いモデルに。thinking 系のモデルは `reasoning_effort: "none"` を渡しているので、効かないサーバではモデル側で思考を切る |

## 記事との違い

- デバイス: Stream Deck Neo (8 キー + インフォバー) ではなく VSD M18 (15 キー + 画面なしボタン 3 つ、キーは 64x64 ピクセル)。
  そのため上段 5 つをスペース、残り 10 個をタブにしている。プラグイン SDK も Elgato ではなく VSD Craft (Mirabox StreamDock SDK)
- インフォバー (コンテキスト残量と利用上限) は M18 に表示先が無いので未実装
- RGB ライト (実験的)、「次へ」「読み上げミュート」ボタンは M18 向けの追加

## 注意

- 読み上げのためにターミナルの画面 (直近 200 行) をローカル LLM に渡す。外部に送らないよう `voice.llmUrl` はローカルのままにしておく
- VOICEVOX の音声を公開・配布するときは「VOICEVOX:ずんだもん」のクレジット表記が必要 (自分で聞くだけなら不要)
- テスト: `bash tests/run-tests.sh` (Node 20 以上と Python 3。VSD Craft / herdr / VOICEVOX / LLM は偽物で代用)
