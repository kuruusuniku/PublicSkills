---
name: herdr-deck
description: "herdr で並列に動かしている Claude Code などのエージェントの状態(作業中・確認待ち・完了)を、VSD Craft (VSDinside Stream Dock) や Elgato Stream Deck のボタンの色とドット絵で表示し、押すとそのタブへ移動できるようにする。完了・確認待ちになったら画面をローカル LLM で要約し、ずんだもん(VOICEVOX)が読み上げる。セットアップ・動作確認・トラブルシュートに使う。"
---

# herdr-deck

[herdr](https://herdr.dev)(AI コーディングエージェント向けのターミナルマルチプレクサ)の各タブを、
手元のボタンデバイスに1ボタンずつ割り当てる。

- ボタンの色とドット絵のキャラ「まめ」の動きで、エージェントが **作業中(青) / 確認待ち(赤・点滅) / 完了(緑・ジャンプ) / 待機(灰・寝ている)** かが一目で分かる
- **短押し**: そのタブ(確認待ち・完了のペイン)へ移動。herdr 側で既読になり、色が戻る
- **長押し**: ずんだもんが「いま何をしていて、次に何をすればいいか」を読み上げる
- 完了・確認待ちになると自動で、画面をローカル LLM が要約し、VOICEVOX のずんだもんが読み上げる

着想: [オレのClaude Code作業環境、控えめにいって最高すぎる〜Stream Deckでherdrを操作、完了はずんだもんが読み上げ〜 (SIOS Tech Lab)](https://tech-lab.sios.jp/archives/54936)。
元記事のソースは非公開なので、ここにあるのは同じ体験を目指した独自実装。

## 構成

```
herdr ──(1.2秒ごとに `herdr api snapshot`)──▶ プラグイン ──▶ ボタンの絵 (SVG)
  ▲                                              │
  └──(押したら `herdr agent focus` / `tab focus`) ┘
                                                 │ 完了・確認待ち
                                                 ▼
                  `herdr pane read` → ローカル LLM (Ollama 等) → VOICEVOX → 再生
```

| 場所 | 中身 |
|---|---|
| `plugin/src/core/` | デバイスに依存しない本体 (herdr 監視・状態判定・読み上げ・ボタン描画) |
| `plugin/src/vsd.ts` | **VSD Craft 用**の入口 (Stream Deck 互換の WebSocket プロトコルを直接話す) |
| `plugin/src/plugin.ts` | **Elgato Stream Deck 用**の入口 (公式 SDK v3) |
| `plugin/src/cli.ts` | CLI `herdr-deck` (デバイスなしの監視・読み上げ、点検) |
| `plugin/vsd/com.kuruusuniku.herdr-deck.sdPlugin/` | VSD Craft 用プラグイン (ビルドで `bin/` `imgs/` `ui/` ができる) |
| `plugin/com.kuruusuniku.herdr-deck.sdPlugin/` | Stream Deck 用プラグイン |

## 必要なもの

| もの | 用途 | 無い場合 |
|---|---|---|
| herdr | 監視対象 | 必須。`curl -fsSL https://herdr.dev/install.sh \| sh` |
| Node.js 22.18 以上 | ビルド・CLI | 必須 (ビルドする Mac に) |
| VSD Craft 3.10.188 以上 **または** Stream Deck 7.1 以上 | ボタン | どちらも無ければ `herdr-deck watch` で読み上げだけ使える |
| VOICEVOX (アプリ or ENGINE) | ずんだもんの声 | macOS は `say` で代わりに読む |
| Ollama / LM Studio など OpenAI 互換のローカル LLM | 画面の要約 | 定型文(「〇〇の作業が終わったのだ」)で読み上げる |

## Workflow (このスキルを使う Claude 向け)

このスキルはユーザーのマシン上で実行する前提。クラウドのセッションからは USB のデバイスに触れない。

### Phase 1: 前提の確認

```bash
herdr --version && herdr status          # herdr が入っていて、サーバーが動いているか
node --version                           # v22.18 以上
curl -s http://127.0.0.1:50021/version   # VOICEVOX ENGINE (起動していれば番号が返る)
curl -s http://127.0.0.1:11434/v1/models # Ollama (LM Studio なら :1234)
ls "/Applications/VSD Craft.app" 2>/dev/null; ls "/Applications/Elgato Stream Deck.app" 2>/dev/null
```

足りないものはユーザーに入れてもらう。LLM のモデルが無ければ `ollama pull gemma3:4b` など(日本語が話せるもの)。

### Phase 2: ビルドとテスト

```bash
SKILL_DIR="$HOME/.claude/skills/herdr-deck"   # このリポジトリから直接使うなら herdr-deck/
cd "$SKILL_DIR/plugin"
npm install
npm run build      # 両プラグインと CLI (dist/herdr-deck.mjs) を作る
npm test           # 偽の herdr / LLM / VOICEVOX / VSD Craft を使ったテスト
```

### Phase 3: 設定と点検

```bash
node dist/herdr-deck.mjs init      # ~/.config/herdr-deck/config.json を作る
node dist/herdr-deck.mjs doctor    # herdr / LLM / VOICEVOX / 再生コマンドを点検
node dist/herdr-deck.mjs say       # ずんだもんがしゃべれば音声まわりは OK
node dist/herdr-deck.mjs status    # herdr のタブと状態の一覧
```

`config.json` で最低限見直すところ:

- `herdr.path`: `which herdr` の結果を書いておくと確実 (デバイスのアプリから起動されると PATH が最小限なので)
- `llm.model`: `doctor` が「ありません」と言ったら、手元にあるモデル名にする
- `deck.activateApp`: ボタンを押したときに前面に出したいターミナルアプリ名 (`"Ghostty"` `"WezTerm"` `"iTerm"` など)

設定ファイルは保存すると再起動なしで反映される。

### Phase 4a: VSD Craft に入れる

```bash
bash scripts/install-vsd.sh
# プラグインフォルダが見つからないと言われたら、VSD Craft の 設定 → 一般 →「アプリケーションフォルダを開く」で
# 開いたフォルダの中の plugins を指定する:
# bash scripts/install-vsd.sh "/Users/<you>/Library/Application Support/HotSpot/StreamDock/plugins"
```

VSD Craft を終了して起動し直し、アクション一覧の **herdr deck → herdr タブ** をボタンに並べる。
並べた位置(左上から右へ)の順に herdr のタブが割り当たる。ボタンの設定画面で「タブ番号」を入れると固定できる。

### Phase 4b: Elgato Stream Deck に入れる

```bash
npm run link       # streamdeck link: Stream Deck アプリにプラグインを登録
npm run restart
```

### Phase 4c: デバイスなしで使う

```bash
node dist/herdr-deck.mjs watch     # 状態の一覧を出し続け、完了・確認待ちを読み上げる
```

### Phase 5: 実機での確認

1. herdr で Claude Code を動かしているタブのボタンが **青で「…」が増えていく** こと
2. 終わったら **緑でジャンプ** し、ずんだもんが要約を読み上げること
3. ボタンを押すとそのタブに移動し、ボタンが **灰色(待機)** に戻ること
4. 長押し(0.6秒以上)で今の様子を読み上げること

## トラブルシュート

| 症状 | 見るところ・直し方 |
|---|---|
| VSD Craft のアクション一覧に出てこない | VSD Craft を完全に終了して起動し直す。それでも出なければ 設定 → 一般 → アプリケーションフォルダ の `Storeache` の中身を消して再起動。VSD Craft が古いと Node.js が同梱されていないので更新する |
| ボタンが真っ黒・空白のまま (VSD) | `~/.config/herdr-deck/vsd-plugin.log` を見る。ログが動いているのに絵が出ないなら `config.json` の `deck.imageFormat` を `"svg-base64"` にする |
| すべてのボタンが「herdr 未接続」 | herdr のサーバーが動いていない、または見つからない。`herdr status`、`config.json` の `herdr.path` |
| ボタンの割り当て順がおかしい | デバイスが位置情報を送ってこない場合がある。各ボタンの設定画面で「タブ番号」を入れる |
| 読み上げが定型文になる | LLM に繋がっていない。`doctor` を実行。モデル名・`llm.baseUrl` を確認 |
| 声が出ない | VOICEVOX を起動する。`say` サブコマンドで確認。再生コマンドは `voice.player` で変えられる |
| Stream Deck 側のログ | `com.kuruusuniku.herdr-deck.sdPlugin/logs/` |

詳しいログが欲しいときは、VSD 版は環境変数 `HERDR_DECK_DEBUG=1`、CLI は `-v`。

## 設定 (`~/.config/herdr-deck/config.json`)

| キー | 既定値 | 意味 |
|---|---|---|
| `herdr.path` | `null` (自動で探す) | herdr のフルパス |
| `herdr.session` | `null` | 名前付きセッションを使うときの名前 |
| `herdr.pollMs` | `1200` | 監視の間隔 |
| `deck.tabs` | `"all"` | `"agents"` にするとエージェントのいるタブだけをボタンに並べる |
| `deck.animation` / `deck.frameMs` | `true` / `300` | ドット絵のアニメーション |
| `deck.activateApp` | `null` | 押したときに前面に出すアプリ (macOS) |
| `deck.imageFormat` | `"auto"` | ボタン画像の形式。VSD は `svg-raw`、Stream Deck は `svg-base64` が既定 |
| `voice.enabled` | `true` | 読み上げ全体のオンオフ |
| `voice.announce` | `["done", "blocked"]` | 自動で読み上げる出来事 |
| `voice.skipFocused` | `false` | herdr で見ているペインの完了は読まない |
| `voice.voicevox.url` / `speaker` | `http://127.0.0.1:50021` / `3` | 3 = ずんだもん(ノーマル)。`doctor` で他のスタイル ID が分かる |
| `voice.voicevox.speedScale` | `1.15` | 話す速さ |
| `voice.player` | `null` (macOS は afplay) | 再生コマンド。`{file}` が WAV のパス |
| `voice.fallbackSay` | `true` | VOICEVOX が無いとき macOS の say で読む |
| `llm.baseUrl` | `http://127.0.0.1:11434/v1` | OpenAI 互換 API (Ollama)。LM Studio は `:1234/v1` |
| `llm.model` | `gemma3:4b` | 要約に使うモデル |
| `llm.maxChars` / `llm.screenLines` | `110` / `120` | 読み上げの長さ / LLM に渡す画面の行数 |

## Gotchas

- **画面の内容が LLM に送られる**: 既定はローカル (localhost) の LLM。`llm.baseUrl` を外部にすると、ターミナルに映っているもの(秘密情報を含みうる)がそこへ送られる。`doctor` はローカル以外だと警告する
- **完了の判定は herdr 任せ**: herdr が working/blocked → idle の遷移で発行する `completion_seq` を見ているので、ポーリングの合間に終わっても取りこぼさない。起動直後と herdr 再接続直後は「現状把握」だけで、しゃべらない
- **VOICEVOX の利用規約**: 生成した音声を動画などで公開・配布するときは「VOICEVOX:ずんだもん」のクレジットが必要。使い方ごとの条件は VOICEVOX とずんだもんの利用規約を確認する
- **VSD Craft は Elgato SDK を使わない**: Elgato 公式 SDK は Stream Deck 7.1 未満で起動を拒否するため、VSD 版は同じプロトコルを直接話す別エントリ (`src/vsd.ts`) になっている。ボタンの振る舞いは `src/core/deck-controller.ts` で共通
- **VSD 実機での確認はまだ**: VSD 版は「偽の VSD Craft」相手のテストで動作を確認している。実機で表示がおかしいときは上のトラブルシュートを順に試し、ログを添えて直す
- **ドット絵キャラ「まめ」はオリジナル**: ずんだ餅をイメージした枝豆キャラで、ずんだもんの公式立ち絵は使っていない
