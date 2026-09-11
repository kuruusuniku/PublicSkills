# PublicSkills

[Claude Code](https://claude.com/claude-code) の skill を公開しているリポジトリです。

## 収録skill

| skill | 概要 |
|---|---|
| [run-slack-html](run-slack-html/) | Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作る |

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
- 内容に合った**高品質な画像を埋め込み**、ファイルサイズを自然に1MB超にして、スニペット展開を回避する
- 画像は最初から `<img src="data:image/...;base64,...">` として埋め込み、外部リソースを一切使わない
- ライト/ダークモード両対応(`prefers-color-scheme`のみ、JSトグル不要)
- 開閉要素は `<details>`/`<summary>` で実装(JS不要)

生成物は単一の `*.html` ファイルなので、Slackにドラッグ&ドロップするだけで共有できます。

### 画像生成について(2経路)

1MB超を稼ぐ画像は、環境に応じて2つの経路のどちらかで用意します。**どちらか一方があれば動きます。**

| 経路 | 前提 | 生成されるもの |
|---|---|---|
| **2-A**(既定) | `run-ai-images` skillが入っている | AI生成のキービジュアル |
| **2-B**(フォールバック) | Chrome/Chromiumが入っている | Claudeが書いたSVG図解をラスタライズしたPNG |

`run-ai-images` が無い環境では自動的に2-Bに落ちます。同梱の `scripts/svg2png.sh` が
Chromeヘッドレスで SVG → PNG 変換を行います(ImageMagickのSVG変換は日本語フォントで
失敗しやすいため使いません)。

```bash
bash run-slack-html/scripts/svg2png.sh input.svg output.png --scale 2
# => OK  /abs/path/output.png  1200x1200css @2x = 2400x2400px  704657 bytes (688KB, base64後 約918KB)
```

実測では 1200x1200 @2x の図解が PNG 430KB〜690KB(base64後 570KB〜920KB)なので、
**図解1〜2枚で1MiB要件を満たせます**(このリポジトリでは、AI画像を一切使わず図解2枚だけで
2.44MB・`verify.sh` ALL PASS になることを確認済み)。

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

## ライセンス

社内共有目的で公開しています。ご自由にご利用・改変ください。
