# PublicSkills

[Claude Code](https://claude.com/claude-code) の skill を公開しているリポジトリです。

## 収録skill

| skill | 概要 |
|---|---|
| [run-slack-html](run-slack-html/) | Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作る |
| [reaper-compose](reaper-compose/) | REAPERで、ピアノで弾いたMIDIをもとにClaudeと相談しながら曲を作る(分析・アレンジ提案・MIDIの書き込み) |

## インストール

使いたいskillのフォルダを、Claude Codeのskillsディレクトリにコピーしてください。

```bash
git clone https://github.com/kuruusuniku/PublicSkills /tmp/PublicSkills

# 個人用(全プロジェクト共通)
cp -r /tmp/PublicSkills/run-slack-html ~/.claude/skills/

# もしくは特定プロジェクトだけで使う場合
cp -r /tmp/PublicSkills/run-slack-html <project>/.claude/skills/
```

---

## run-slack-html

Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作るためのskillです。

### 何を解決するか

Slackモバイルは、小さいHTML/テキストファイルを添付すると**コードスニペットとして展開表示**してしまい、レイアウトが崩れて読みにくくなることがあります。このskillは:

- **JavaScript非依存**で、タイトル・本文・画像・出典がすべて読める設計にする
- 内容に合った**図版を埋め込み**、ファイルサイズを自然に1MB超にして、スニペット展開を回避する
- 画像は最初から `<img src="data:image/...;base64,...">` として埋め込み、外部リソースを一切使わない
- ライト/ダークモード両対応(`prefers-color-scheme`のみ、JSトグル不要)
- 開閉要素は `<details>`/`<summary>` で実装(JS不要)

生成物は単一の `*.html` ファイルなので、Slackにドラッグ&ドロップするだけで共有できます。

### 図版生成エンジンを同梱しています

画像生成のために別のツールを入れる必要はありません。`scripts/make-images.sh` が
skill 内で完結しており、環境に応じて自動で切り替わります。

| 条件 | 使われるエンジン | 備考 |
|---|---|---|
| `codex` CLI があってログイン済み | codex | AI生成画像 |
| それ以外 | **SVG**(同梱) | **ネットワーク不要**。Chrome があれば動く |

SVGエンジンは hero / flow / compare / checklist / stat の5種類の図版を、
spec(JSON)から描きます。日本語ラベルは自動で折り返し・省略されます。

合計バイト数が1MiBに必要な量へ届くまで解像度と品質を段階的に上げるので、
「Slackでスニペット展開されない大きさ」が機械的に担保されます
(パディングではなく実画像でサイズを稼ぎます)。

### 使い方

Claude Codeのセッション内で以下のように依頼してください:

```
/run-slack-html 来週の全社定例の議事録をSlackモバイルで読みやすいHTMLにして
```

またはSKILL.mdの内容を直接読んだ上で、既存のClaude Codeセッションに「run-slack-html skillの手順で」と伝えても動作します。

### 検証スクリプト

生成したHTMLが絶対要件(ファイルサイズ・JS非依存・base64整合性など)を満たしているか、
同梱の `scripts/verify.sh` で機械的にチェックできます。

```bash
bash run-slack-html/scripts/verify.sh path/to/your-file-slack-mobile.html
```

### 動作に必要なもの

| ツール | 用途 | 無い場合 |
|---|---|---|
| Claude Code | skill の実行 | 必須 |
| Python 3 | 図版仕様の検証とSVG生成 | 必須 (macOSは標準搭載) |
| Chrome / Chromium | SVGのラスタライズ | `rsvg-convert` でも可。どちらも無いと図版を作れない |
| ImageMagick (`magick`) | JPEG変換 | 無い場合はPNGで出力(ファイルサイズは大きくなる) |
| codex CLI | AI画像生成 | 無くてもSVGエンジンで動く |

---

## reaper-compose

REAPER で、**自分が弾いた MIDI をもとに Claude と相談しながら曲を作る**ための skill です(macOS 向け)。

### 何ができるか

- REAPER のプロジェクトと MIDI を読み、調・コード進行・構成・旋律の特徴を分析して伝える
  (コードはペダル・分数コード・経過音を考慮して推定し、Claude がノートを見て確かめる)
- 音楽理論にもとづいて、リハーモナイズ・ベース・ドラム・パッド・対旋律などの案を理由つきで出す
- 決まった案を REAPER の**新しいトラックに直接書き込み**、聴いてほしい小節から再生する
- 曲ごとのノート(コンセプト、決めたこと、却下した案、次にやること)を残し、次の作業で続きから再開できる

Claude は音を聴けないので、判断はノートと理論から行い、聴いた感想は言葉で伝えてもらう前提です。

### 仕組み

```
Claude Code ──(reaper_ai.py)──▶ ~/ReaperAI/.bridge/inbox/*.json ──▶ ai_bridge.lua (REAPER に常駐)
            ◀──────────────────  ~/ReaperAI/.bridge/outbox/*.json ◀──  ReaScript API で読み書き
```

- `reaper/ai_bridge.lua`: REAPER の中で動くブリッジ。書き込みは 1 回の Undo にまとまるので Cmd+Z で戻せる
- `scripts/reaper_ai.py`: Claude が使う CLI(標準ライブラリのみ)。MIDI のテキスト表示、調・コード推定、.mid の読み書きも担う
- ユーザーが弾いたテイクは書き換えず、AI の案は `Bass v1 (AI)` のような新しいトラックに書く

### 必要なもの

| もの | 備考 |
|---|---|
| macOS | Windows は未対応(パスの扱いを直せば動く設計) |
| REAPER 7 | 60日間の試用あり |
| Claude Code(デスクトップアプリか CLI) | REAPER と同じ Mac で動かす |
| Python 3.9 以上 | 無ければ `xcode-select --install` |

### インストール

```bash
git clone https://github.com/kuruusuniku/PublicSkills /tmp/PublicSkills
bash /tmp/PublicSkills/reaper-compose/scripts/install.sh --autostart
```

`--autostart` を付けると、REAPER の起動時にブリッジが自動で立ち上がります。付けない場合は、
REAPER で Actions → Show action list → New action → Load ReaScript... から
`Scripts/ReaperAI/ai_bridge.lua` を読み込んで実行してください。

そのあと Claude Code のデスクトップアプリで `~/ReaperAI` フォルダを開き、
「REAPER とつながってるか確認して」と話しかけると始められます。

### 使い方の例

```
いまREAPERで選択してる8小節、ピアノで弾いたAメロのアイデア。分析して、ここからどう広げられるか相談したい
このコード進行で、もう少し切ない感じのリハモ案を2つ出して
ベースとドラムを入れてみて。テンポ感は落ち着いたシティポップ寄りで
5〜8小節のベース、歌とぶつかってる気がする
```

### REAPER でピアノを録音するまで(Cubase から来た人向けの最小手順)

1. Preferences → Audio → Device でオーディオインターフェースを選ぶ。MIDI Devices で鍵盤の入力を Enable にする
2. Cmd+T でトラックを作り、FX ボタンからピアノ音源(VSTi / AUi)を挿す
3. トラックの録音ボタンを押して入力を「Input: MIDI → 鍵盤 → All channels」にし、モニターを ON
4. 録音して、できたアイテムをクリックで選択 → Claude に「選択中のアイテムを読んで」

用語の対応: Cubase の「イベント/パート」は REAPER の「アイテム」、インストゥルメントトラックは「音源を挿した普通のトラック」です。
音名は REAPER が C4=60、Cubase が C3=60 で 1 オクターブ表記がずれます。

### テスト

```bash
bash reaper-compose/tests/run-tests.sh
```

REAPER の API を引数と戻り値の型まで真似たモック上でブリッジを動かし、CLI からの通しの操作
(読み込み・書き込み・拍子の変わる箇所・エラー処理・常駐ループ)を確かめます。

### 動作確認の状況

- 上のテストはすべて通っていますが、**実機の REAPER ではまだ動かしていません**
  (関数の仕様は REAPER 公式 SDK のヘッダーで確認して実装)
- 初回に Claude が `selftest` で小節/拍の変換が REAPER と一致するかを確かめます。
  不具合があれば Claude Code のセッション内でブリッジを直せるようにしてあります

## ライセンス

社内共有目的で公開しています。ご自由にご利用・改変ください。
販売など利益を取る場合は許諾が必要です
