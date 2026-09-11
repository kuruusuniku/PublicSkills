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

### Phase 2: 図版生成

同梱の`scripts/make-images.sh`で図版を作る。**外部スキル・プラグインには依存しない**
(このskillのディレクトリだけで完結する)。

まず本文の構成に合わせて図版の仕様を`spec.json`に書き、それを渡す。

```bash
SKILL_DIR="$HOME/.claude/skills/run-slack-html"
OUT="output/slack-html-{slug}"

cat > "$OUT/spec.json" <<'EOF'
{
  "palette": "amber-slate",
  "figures": [
    { "type": "hero", "title": "<記事タイトル>", "subtitle": "<副題>", "alt": "<図の説明>" },
    { "type": "flow", "steps": ["<段階1>", "<段階2>", "<段階3>"], "alt": "<図の説明>" },
    { "type": "compare",
      "left":  { "label": "<左の見出し>", "items": ["<項目>", "<項目>"] },
      "right": { "label": "<右の見出し>", "items": ["<項目>", "<項目>"] },
      "alt": "<図の説明>" },
    { "type": "checklist",
      "items": [ {"text": "<項目>", "ok": true}, {"text": "<項目>", "ok": false} ],
      "alt": "<図の説明>" },
    { "type": "stat", "value": "<数値>", "label": "<意味>", "alt": "<図の説明>" }
  ]
}
EOF

bash "$SKILL_DIR/scripts/make-images.sh" --spec "$OUT/spec.json" --outdir "$OUT/images"
```

engineは自動で選ばれる:

| 条件 | engine | 備考 |
|---|---|---|
| `codex` CLI があってログイン済み | codex | AI生成画像。1枚あたり40〜60秒 |
| それ以外 | svg | 同梱のSVGエンジン。**ネットワーク不要**、Chromeがあれば動く |

`--engine svg` / `--engine codex` で明示指定もできる(codexを明示して使えないときは
黙ってsvgに落ちず、エラー終了する)。

出力:

- `$OUT/images/fig-01.jpg`, `fig-02.jpg`, ... (spec の figures 順)
  - **拡張子を決め打ちしない。** ImageMagick(`magick`)が無い環境では`.png`で出力される。
    実際のファイル名は必ず`manifest.json`の`file`から読む
- `$OUT/images/manifest.json` — 呼び出し側が依存してよい形は下記

```json
{
  "engine": "svg",
  "figure_count": 5,
  "total_bytes": 1145143,
  "target_met": true,
  "figures": [
    { "index": 0, "file": "fig-01.jpg", "type": "hero",
      "alt": "<spec の alt がそのまま入る>", "bytes": 247544, "format": "jpg" }
  ]
}
```

  `file` は `$OUT/images/` からの相対名。`target_met` が `false` なら図版を足して再実行する
- 標準出力の最終行に `TOTAL_BYTES=<n> ENGINE=<svg|codex>`

**`manifest.json`の`alt`をそのままHTMLの`alt`属性に使う。**
これで「すべての`<img>`にalt」という絶対要件が機械的に担保される。

- 合計バイトが1MiBに必要な量へ届かないと**警告が出る**。そのときは
  **本文の別セクションに合う図版をspecに足して再実行**する。
  無意味なパディングでサイズを稼ぐのは要件違反
- 図版5枚でおおよそ1.1MB前後(base64化後で約1.5MB)になる。3枚だと届かないことがある
- figureの型は hero / flow / compare / checklist / stat の5種。palette は
  amber-slate / indigo-mist / teal-sand
- **図版は本文の内容と結びつけること。** 意味のない飾り画像を並べてサイズを稼がない

### Phase 3: HTML組み立て

1ファイルに以下を全部インラインで書く:

- `<style>`内に完結したCSS。`:root`にライトモードのトークン(文字色・背景・アクセント等)、
  `@media (prefers-color-scheme: dark)`内で同トークンを再定義するだけ(JSのテーマ切替は作らない)
- 本文は`<article>`または意味のある`<section>`群。見出しには`id`を振り、目次があれば
  `<a href="#id">`でジャンプできるようにする
- 折りたたみが要る箇所(長い引用・補足・議事録の詳細メモなど)は`<details><summary>...</summary>...</details>`
- 画像はこの段階では一旦ローカル相対パスで仮置きし、HTMLの構造を完成させてから
  次のステップでbase64に差し替える(base64文字列を直接書きながらタグ構造を編集すると
  事故りやすいため)
- **`src`も`alt`も`manifest.json`の値をそのまま使う**(手で書き直さない)。
  `src`は`"images/" + file`、`alt`は`alt`をそのまま。これで拡張子の食い違いと
  alt の書き漏れが同時に防げる

```html
<img src="images/<manifest.json の file>" alt="<manifest.json の alt>" loading="lazy">
```

### Phase 4: base64埋め込み + サイズ検証

Pythonでの一括置換(base64文字列を会話に貼らずファイル間コピーで完結させる):

```bash
cd output/slack-html-{slug}
python3 - <<'EOF'
import base64, json, pathlib

html_path = "{basename}-slack-mobile.html"
html = pathlib.Path(html_path).read_text(encoding="utf-8")

manifest = json.loads(pathlib.Path("images/manifest.json").read_text(encoding="utf-8"))
for rel in ["images/" + f["file"] for f in manifest["figures"]]:
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
- **画像はJPEGで埋め込む**: `make-images.sh`は既定でJPEGを出し、合計バイトが
  目標に届くまで解像度と品質を段階的に上げる。PNGのままbase64化すると1枚で
  数MBになり、Slackの添付上限にも近づくので避ける(magickが無い環境では
  PNGで出力され、その旨が`manifest.json`の`notes`に記録される)
- **base64はファイル間コピーで組み立てる**: 会話内でbase64文字列をタイプ/貼り付けしない。
  Pythonスクリプトでファイルを読んでHTMLに書き込む(Phase 4のパターン)。これは
  誤りにくく、かつbase64破損(改行混入・エンコード崩れ)を防ぐ
- **`<details>`のデフォルト状態**: 議事録の「決定事項」など常に見せたい情報を
  `<details>`の中に隠さない。折りたたみは補足情報だけに使う
- **ダークモードは`prefers-color-scheme`のみ**: Slackモバイルのアプリ内ブラウザ/
  プレビューがOSのダークモード設定を反映する前提で作る。トグルUIやJSでの検出は不要
- **図版が作れないときはまず`--engine svg`を試す**: `make-images.sh`はcodexが使えれば
  codexを選ぶが、codex側の不調で止まることがある。`--engine svg`なら
  ネットワーク不要で必ず図版が出る(Chromeが要る)。なおcodexの
  自動承認フラグは`make-images.sh`がCLIのバージョンを見て解決するので、
  呼び出し側で気にする必要はない。参考: `codex exec --full-auto`は
  codex CLI 0.154 で廃止された(後継は`--sandbox workspace-write`)。古いフラグを渡すと
  codex は usage を出して即終了するが、呼び出し側のスクリプトはこれを
  「image_gen未保存 → 認証切れの可能性大」と誤報告しがち。`codex login status`が
  正常なのに`result: 0/N succeeded`になったらこれを疑う
- **元ファイルは絶対に上書きしない**: 既存の記事/資料HTMLを変換する依頼が来た場合、
  読み込みは元ファイルから、書き込みは必ず`{元のファイル名}-slack-mobile.html`の
  新規ファイルへ
