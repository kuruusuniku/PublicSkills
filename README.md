# PublicSkills

[Claude Code](https://claude.com/claude-code) の skill を公開しているリポジトリです。

## 収録skill

| skill | 概要 |
|---|---|
| [run-slack-html](run-slack-html/) | Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作る |
| [herdr-vsd-deck](herdr-vsd-deck/) | herdr のスペースとタブを VSD Craft (Stream Dock) のボタンに並べ、住人のドット絵で Claude Code の状態を表示。押せばそのターミナルへ、終わればずんだもんが読み上げる |

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

## herdr-vsd-deck

[SIOS Tech Lab の記事](https://tech-lab.sios.jp/archives/54936)
「オレのClaude Code作業環境、控えめにいって最高すぎる〜Stream Deckでherdrを操作、完了はずんだもんが読み上げ〜」
の仕組みを、Elgato Stream Deck ではなく **VSD Craft で動く Stream Dock 系デバイス** (VSD M18 など) で再現する skill です。
記事に載っている「このプラグインを作ったプロンプト」の仕様に沿って作っています。

- **ボタンで状態が分かる**: 上段に [herdr](https://herdr.dev) のスペース、下段に選んだスペースのタブ。
  タブのボタンにはドット絵のキャラクターが住んでいて、作業中 (黄・机でタイピング) / 確認待ち (赤・手を振って「!」) /
  完了 (ミント・バンザイ) / 待機 (青・居眠り) / エージェントなし (紫・空席) を演じる。
  スペースのボタンには住人の顔が並ぶので、スペースに入らなくても確認待ちに気づける
- **押すとそのターミナルへ**: herdr のスペース・タブを切り替え、ターミナルアプリを前面に出す (別のデスクトップにあっても)
- **ずんだもんが読み上げ**: 作業が終わった・確認待ちになったタブの画面をローカル LLM が
  「何をした → どうなった → 次に何をすればいいか」にまとめ、VOICEVOX のずんだもんが「<スペース名>から。」で読み上げる
- **VSD M18 (縦3×横5) 向け**: 64x64 ピクセルのキーでもにじまない描画。上段5つがスペース、残り10個がタブ。
  画面なしの3ボタンには「急ぎへ」「次へ」「読み上げミュート」。枠の RGB ライトを状態色にする実験的機能つき (`--with-led`)

### インストール

```bash
git clone https://github.com/kuruusuniku/PublicSkills /tmp/PublicSkills
cp -r /tmp/PublicSkills/herdr-vsd-deck ~/.claude/skills/

# Claude Code に「/herdr-vsd-deck でセットアップして」と頼むか、手で:
python3 ~/.claude/skills/herdr-vsd-deck/install.py --restart             # macOS: 配置後に VSD Craft を再起動
python3 ~/.claude/skills/herdr-vsd-deck/install.py --restart --with-led  # M18 の RGB ライトも使う (npm が必要)
```

インストーラは VSD Craft のプラグインフォルダにプラグインを置くだけで、Claude Code の設定には触りません
(読み上げはプラグインが herdr の画面を読んで行います)。VSD Craft のアクション一覧の **herdr Deck** から
上段に「herdr スペース」、その下に「herdr タブ」を並べてください。詳しい手順・設定・トラブルシュートは
[SKILL.md](herdr-vsd-deck/SKILL.md) にあります。

### 動作に必要なもの

| ツール | 用途 | 無い場合 |
|---|---|---|
| VSD Craft 3.10.191 以降 (macOS / Windows) | プラグインの実行 (組み込み Node 20 を使うので npm 不要) | 必須 |
| herdr | スペース・タブ・エージェントの状態と切り替え | 必須 |
| VOICEVOX | ずんだもんの声 | 読み上げなし |
| Ollama などのローカル LLM (記事は qwen3.5:9b) | 画面を読み上げ文にする | 読み上げなし |
| Python 3 | インストーラと確認用スクリプト | macOS は標準で入っている |

テストは `bash herdr-vsd-deck/tests/run-tests.sh` (VSD Craft / herdr / VOICEVOX / LLM は偽物で代用)。

## ライセンス

社内共有目的で公開しています。ご自由にご利用・改変ください。
販売など利益を取る場合は許諾が必要です
