---
name: run-slack-html
description: "Slackモバイルアプリで快適に閲覧できる、単一ファイルの自己完結HTML(記事・議事録・資料)を作る。JS非依存で全文が読める設計にした上で、内容に合った高品質な埋め込み画像でファイルサイズを1MB超にし、Slackのコードスニペット展開表示を回避する。"
---

# run-slack-html

Slackモバイルアプリ(iOS/Android)でHTMLファイルを共有すると、ファイルが小さいと
コードスニペットとして展開表示され読みにくくなる。このskillは、単一ファイルの
自己完結HTML(記事・議事録・資料など)を、**JavaScript非依存で全文が読める設計**にした上で、
**内容に合った高品質な画像を埋め込んでファイルサイズを1MB超にする**ことでこれを回避する。

## Input / Output

- **Input**: `args` = 作りたい記事・議事録・資料の内容(トピック文字列、渡された本文、または参照ファイルパス)
- **Output**: `output/slack-html-{slug}/{basename}-slack-mobile.html` (単一ファイル、1.2MB以上)
- **副産物**: 同ディレクトリに生成した画像原本(`images/`)を残す(再生成用。HTML内は埋め込み済みなので配布は`*-slack-mobile.html`単体でよい)

## 絶対要件(すべて検証必須 — Phase 4で機械的にチェックする)

| 項目 | 要件 |
|---|---|
| 文字コード | UTF-8、`<meta charset="utf-8">` |
| ファイル | 単一HTMLファイル(CSS/JS/画像すべてインライン、外部参照ゼロ) |
| サイズ | **1,048,576 バイト(1MiB)を超える**こと(目安1.2MB以上を狙う) |
| 画像埋め込み | `<img src="data:image/...;base64,...">` を**最初から直接**指定。JSで後からsrcを書き換えない |
| JS依存の禁止 | タイトル・本文・画像・出典は**JS無効でも全部見える**。`fetch`/`localStorage`/`AudioContext`/`Canvas`/`Blob URL`/外部ライブラリ不使用。`.js`クラスが付かないと本文が非表示になる構造禁止 |
| ナビゲーション | 通常の`<a href="#id">`アンカーリンクのみ |
| 開閉要素 | JSではなく`<details>`/`<summary>` |
| スクロール | 通常の縦スクロールで全文を読める。`height:100%`+`overflow:hidden`でページ全体を固定しない |
| レスポンシブ | iPhone縦画面基準のフォントサイズ・余白、横スクロールなし |
| ダーク/ライト | `prefers-color-scheme`メディアクエリで両対応(JSトグル不要) |
| タップ領域 | リンク・見出しアンカー等は最低44px相当 |
| 画像alt | すべての`<img>`に内容を説明する`alt` |
| 外部リソース | 外部フォント・外部CSS・外部画像を一切使わない |
| 元ファイル | 既存ファイルを変換する場合は上書きせず、`{元のファイル名}-slack-mobile.html`として別名保存 |

## Workflow

### Phase 1: 内容の確定

`args`を解釈し、本文(見出し構成・段落・箇条書き・出典)を通常のMarkdown的な構造で
書き下ろす。議事録なら日時・参加者・決定事項・ToDoを明確に分ける。記事なら
リード文→本文→まとめの構成にする。**ここが本質的な執筆作業** — 後続フェーズは
この内容を制約内に収める作業でしかない。

### Phase 2: キービジュアル生成

内容に合った高品質な画像を1〜3枚生成する。`run-ai-images`と同じengineを直接叩く
(詳細は`.claude/skills/run-ai-images/scripts/generate.sh`のコメント参照。本体は
plugin cache配下にあることが多い — `find ~/.claude -iname generate.sh -path "*run-ai-images*"`
で解決してから叩く)。

```bash
GEN=$(find ~/.claude -iname "generate.sh" -path "*run-ai-images*" 2>/dev/null | head -1)
bash "$GEN" -o "output/slack-html-{slug}/images/hero" --aspect 1:1 --format jpg --quality high -n 1 \
  -p "<内容に合った説明的なプロンプト。モバイル読者が縦スクロールで見る前提なので 1:1 か 3:2(縦寄り)を推奨、16:9のワイド画像は縦画面で小さく表示されがちなので避ける>"
```

- `--format jpg --quality high`で最初からJPEG生成する(PNGのままbase64化すると
  1枚で数MBになり、後段のリサイズ変換の手間が増える。テキスト情報量の多い
  グラレコ風・図解系イラストでもJPEG品質lowはやめてhighにする — 圧縮でラベル文字が
  潰れると本文の代わりにならない)
- 枚数とサイズは「内容に合っているか」を優先して決め、**水増し目的の無意味な画像は使わない**。
  1枚だけでは1MBに届かない場合は、本文の別セクションに合う2枚目・3枚目を足す
  (単純な高画質化より、内容と結びついた画像を増やす方を優先する)

### Phase 3: HTML組み立て

1ファイルに以下を全部インラインで書く:

- `<style>`内に完結したCSS。`:root`にライトモードのトークン(文字色・背景・アクセント等)、
  `@media (prefers-color-scheme: dark)`内で同トークンを再定義するだけ(JSのテーマ切替は作らない)
- 本文は`<article>`または意味のある`<section>`群。見出しには`id`を振り、目次があれば
  `<a href="#id">`でジャンプできるようにする
- 折りたたみが要る箇所(長い引用・補足・議事録の詳細メモなど)は`<details><summary>...</summary>...</details>`
- 画像はこの段階では一旦ローカル相対パス(`images/hero-01.jpg`)で仮置きし、HTMLの
  構造を完成させてから次のステップでbase64に差し替える(base64文字列を直接書きながら
  タグ構造を編集すると事故りやすいため)

```html
<img src="images/hero-01.jpg" alt="<内容を説明するalt>" loading="lazy">
```

### Phase 4: base64埋め込み + サイズ検証

Pythonでの一括置換(base64文字列を会話に貼らずファイル間コピーで完結させる):

```bash
cd output/slack-html-{slug}
python3 - <<'EOF'
import base64, pathlib

html_path = "{basename}-slack-mobile.html"
html = pathlib.Path(html_path).read_text(encoding="utf-8")

for rel in ["images/hero-01.jpg"]:  # 実際に使った画像パスを列挙
    b64 = base64.b64encode(pathlib.Path(rel).read_bytes()).decode("ascii")
    mime = "image/jpeg" if rel.lower().endswith((".jpg", ".jpeg")) else "image/png"
    old = f'src="{rel}"'
    new = f'src="data:{mime};base64,{b64}"'
    assert html.count(old) >= 1, f"{rel} not found in HTML"
    html = html.replace(old, new)

pathlib.Path(html_path).write_text(html, encoding="utf-8")
print("size bytes:", pathlib.Path(html_path).stat().st_size)
EOF
```

続けて`scripts/verify.sh`で機械検証する(このskill同梱):

```bash
bash .claude/skills/run-slack-html/scripts/verify.sh "output/slack-html-{slug}/{basename}-slack-mobile.html"
```

`verify.sh`は以下を確認し、PASS/FAIL/要目視確認を出す:
1. ファイル名が`-slack-mobile.html`で終わっているか
2. UTF-8宣言があるか
3. サイズが1,048,576バイトを超えているか
4. `data:image/...;base64,`の出現数(埋め込み画像数)と、各base64ブロックが正しくデコードできるか
5. 禁止API(`fetch(`, `localStorage`, `sessionStorage`, `AudioContext`, `getContext(`, `new Blob(`, `XMLHttpRequest`)の有無
6. 外部リソース参照(`href="http`, `src="http`, `url(http`)の有無
7. `height:\s*100%`と`overflow:\s*hidden`の同時使用(全体固定の疑い)
8. `<details>`/`<summary>`の有無(開閉要素を使っている場合の確認用、必須ではない)
9. `display:\s*none`の出現(JS前提で隠している疑いがあれば目視確認を促す — `<noscript>`外での使用は要注意)

FAILが出たら該当箇所を直して再実行する。全PASSするまでPhase 5に進まない。

### Phase 5: 目視確認 + 報告

ブラウザで開いて実際の見た目を確認する(`open`コマンド)。可能なら開発者ツールで
JavaScriptを無効化した状態でも同じ内容が見えることを確認する。

最後に必ず以下を報告する:
- 保存先の絶対パス
- 最終ファイルサイズ(バイト数とMB換算)
- 埋め込んだ画像の枚数
- JavaScriptなしで利用できる機能の一覧(通常は「全機能」になるはず — 本skillはJS非依存を既定にしている)

## Gotchas

- **なぜ1MB超が要るのか**: Slackモバイルは小さいテキスト/HTML系ファイルを添付時に
  コードスニペットとして展開表示することがあり、レイアウトが崩れて読みにくくなる。
  実質的なコンテンツ(高品質画像)で自然に閾値を超えさせるのが目的で、無意味なパディング
  (コメントの水増し・ダミーバイトの追記)で稼ぐのは要件違反 — 必ず内容に合った画像で稼ぐ
- **JSは「付加機能」のみ許可**: どうしても使うなら、例えば「目次のスムーズスクロール」
  のように**無くても全文が読める**ものに限る。初期表示・本文の可視性・画像表示に
  一切関与させない。迷ったらJS自体を書かない
- **画像はJPEGで先に軽量化してから埋め込む**: PNG(特にAI生成のグラレコ風イラストは
  1枚2〜4MB になりがち)をそのままbase64化すると単体で16MB超級の巨大ファイルになり、
  Slackの添付上限にも引っかかりうる。`--format jpg --quality high`で生成するか、
  生成後に`magick <in>.png -resize <適切な解像度> -quality 82 <out>.jpg`で変換する
- **base64はファイル間コピーで組み立てる**: 会話内でbase64文字列をタイプ/貼り付けしない。
  Pythonスクリプトでファイルを読んでHTMLに書き込む(Phase 4のパターン)。これは
  誤りにくく、かつbase64破損(改行混入・エンコード崩れ)を防ぐ
- **`<details>`のデフォルト状態**: 議事録の「決定事項」など常に見せたい情報を
  `<details>`の中に隠さない。折りたたみは補足情報だけに使う
- **ダークモードは`prefers-color-scheme`のみ**: Slackモバイルのアプリ内ブラウザ/
  プレビューがOSのダークモード設定を反映する前提で作る。トグルUIやJSでの検出は不要
- **元ファイルは絶対に上書きしない**: 既存の記事/資料HTMLを変換する依頼が来た場合、
  読み込みは元ファイルから、書き込みは必ず`{元のファイル名}-slack-mobile.html`の
  新規ファイルへ
