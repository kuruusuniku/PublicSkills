# PublicSkills

[Claude Code](https://claude.com/claude-code) の skill を公開しているリポジトリです。

## 収録skill

| skill | 概要 |
|---|---|
| [run-slack-html](run-slack-html/) | Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作る |
| [herdr-vsd-deck](herdr-vsd-deck/) | herdr で動かす Claude Code の状態を VSD Craft (Stream Dock) のキーに表示してワンタッチで移動、完了や許可待ちはずんだもんが読み上げる |

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
と同じ環境を、Elgato Stream Deck ではなく **VSD Craft で動く Stream Dock 系デバイス**
(VSDinside / Mirabox の N3・N4・293 など) で作るための skill です。

- **キーに状態を表示**: [herdr](https://herdr.dev) の中で動いている Claude Code (や Codex など) を1キー1体で表示。
  色とドット絵の羊のアニメーションで 確認待ち(黄・点滅) / 作業中(青・走る) / 完了(緑・跳ねる) / 待機(灰・寝る) がひと目で分かる
- **押すとジャンプ**: そのエージェントのペインへ herdr を切り替え、ターミナルを最前面へ (別デスクトップにあっても)
- **サマリーキー**: 各状態の数を表示し、押すと一番急ぎ (確認待ち→完了→作業中) のエージェントへ。ノブに置けば回して選択
- **VSD M18 (縦3×横5) 向け**: 64x64 ピクセルのキーでも読める表示が既定。画面なしの3ボタンには
  「急ぎへ」「次へ」「読み上げミュート」を置ける。枠の RGB ライトを状態色にする実験的機能つき (`--with-led`)
- **ずんだもんが読み上げ**: Claude Code の作業完了・許可待ち・質問を、ローカルLLM (Ollama など) が
  「どこで何が起きて、次に何をすればいいか」に要約し、VOICEVOX のずんだもんが読み上げる。
  LLM や VOICEVOX が無くても定型文 / OS の読み上げで動く

### インストール

```bash
git clone https://github.com/kuruusuniku/PublicSkills /tmp/PublicSkills
cp -r /tmp/PublicSkills/herdr-vsd-deck ~/.claude/skills/

# Claude Code に「/herdr-vsd-deck でセットアップして」と頼むか、手で:
python3 ~/.claude/skills/herdr-vsd-deck/install.py --restart          # macOS: 配置後に VSD Craft を再起動
python3 ~/.claude/skills/herdr-vsd-deck/install.py --restart --with-led  # M18 の RGB ライトも使う (npm が必要)
```

インストーラが VSD Craft のプラグインフォルダへプラグインを置き、`~/.claude/settings.json` に読み上げフックを
登録します (元の設定はバックアップ)。その後 VSD Craft を再起動して、アクション一覧の **herdr Deck** から
キーを並べてください。詳しい手順・設定・トラブルシュートは [SKILL.md](herdr-vsd-deck/SKILL.md) にあります。

### 動作に必要なもの

| ツール | 用途 | 無い場合 |
|---|---|---|
| VSD Craft 3.10.191 以降 (macOS / Windows) | プラグインの実行 (組み込み Node 20 を使うので npm 不要) | 必須 |
| herdr | エージェントの状態検出とペイン切り替え | 必須 |
| Python 3.9+ | 読み上げフックとインストーラ | 読み上げを使わないなら不要 |
| VOICEVOX | ずんだもんの声 | OS の読み上げで代用 |
| Ollama などのローカル LLM | 読み上げ文の要約 | 定型文で読み上げ |

テストは `bash herdr-vsd-deck/tests/run-tests.sh` (VSD Craft / herdr / VOICEVOX / LLM は偽物で代用)。

## ライセンス

社内共有目的で公開しています。ご自由にご利用・改変ください。
販売など利益を取る場合は許諾が必要です
