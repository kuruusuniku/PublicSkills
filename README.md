# PublicSkills

[Claude Code](https://claude.com/claude-code) の skill を公開しているリポジトリです。

## 収録skill

| skill | 概要 |
|---|---|
| [run-slack-html](run-slack-html/) | Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作る |
| [herdr-deck](herdr-deck/) | herdr で動かしている Claude Code の状態を VSD (Stream Dock) / Stream Deck のボタンに表示し、完了をずんだもんが読み上げる |

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

## herdr-deck

[herdr](https://herdr.dev) で並列に動かしている Claude Code などのエージェントを、手元のボタンデバイスで見張るための skill です。
着想は [SIOS Tech Lab の記事](https://tech-lab.sios.jp/archives/54936) で、元記事のソースは非公開なので独自に実装しています。

- ボタンの色とドット絵のキャラで **作業中(青) / 確認待ち(赤・点滅) / 完了(緑・ジャンプ) / 待機(灰)** が一目で分かる
- 短押しでそのタブへ移動、長押しで「いまどうなってる？」をずんだもんが読み上げ
- 完了・確認待ちになると、画面をローカル LLM (Ollama など) が要約し、VOICEVOX のずんだもんが読み上げる

### 対応デバイス

| デバイス | 状態 |
|---|---|
| VSD Craft (VSDinside / MiraBox の Stream Dock) | 対応 (実機での確認待ち) |
| Elgato Stream Deck (7.1 以上) | 対応 |
| デバイスなし | `herdr-deck watch` で監視と読み上げだけ使える |

### 使い方

```bash
cp -r /tmp/PublicSkills/herdr-deck ~/.claude/skills/
```

ボタンデバイスをつないだ Mac 上の Claude Code で、次のように頼んでください。

```
/herdr-deck VSD Craft にセットアップして動作確認して
```

手で入れる場合は `herdr-deck/plugin` で `npm install && npm run build` のあと、
VSD Craft なら `bash scripts/install-vsd.sh`、Stream Deck なら `npm run link` です。
設定や困ったときの対処は [herdr-deck/SKILL.md](herdr-deck/SKILL.md) にまとめています。

## ライセンス

社内共有目的で公開しています。ご自由にご利用・改変ください。
販売など利益を取る場合は許諾が必要です
