---
name: reaper-compose
description: "REAPERで、ユーザーがピアノで弾いたMIDIをもとに一緒に曲を作る共作スキル。REAPERのプロジェクトとMIDIを読んで調・コード・構成を分析し、音楽理論にもとづいたリハーモナイズ・ベース・ドラム・パッド・対旋律などのアレンジ案を相談しながら決め、REAPERに直接MIDIを書き込む。REAPER、作曲、編曲、MIDI、コード進行、アレンジ、曲のブラッシュアップの相談で使う。"
allowed-tools:
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py status*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py selftest*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py project*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py read*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py write*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py view*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py mid*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py play*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py stop*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py track*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py markers*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py fx*)
  - Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py addfx*)
---

# reaper-compose

ユーザーがピアノで弾いたアイデア(MIDI)を出発点に、**相談しながら一緒に曲を完成させる**ためのskill。
Claudeの役割は、音楽理論を使って分析と提案をし、決まったものをREAPERに書き込む共作者・編曲者。
曲の主導権はユーザーにある。Claudeは選択肢を出し、ユーザーが選ぶ。

## このskillの道具

`scripts/reaper_ai.py` がREAPERとやりとりするCLI。REAPER側では `reaper/ai_bridge.lua` が常駐し、
`~/ReaperAI/.bridge/` のファイルを介して命令を受け取る。

コマンドは**必ず次の形で呼ぶ**(このskillの `allowed-tools` がこの形に合わせてあり、`lua` と `call` 以外は確認なしで実行できる):

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/reaper_ai.py <command> ...
```

以下この文書では `$R` と略す(シェル変数ではないので、実際のコマンドでは毎回上の形に展開して書く)。

| コマンド | 用途 |
|---|---|
| `$R status` | ブリッジが動いているか |
| `$R selftest` | 小節/拍の変換がREAPERと一致するか(初回に1回) |
| `$R project` | トラック・テンポ・拍子・マーカー・選択中のアイテム |
| `$R read [--track 名前] [--bars 9-16] [--summary\|--detail] [--save f.json]` | MIDIを読む(既定は選択中のアイテム)。調・コード推定つき |
| `$R write part.json [--dry-run]` | JSONのMIDIをREAPERに書き込む |
| `$R play [--bar 9] [--loop 9-16]` / `$R stop` | 再生・停止 |
| `$R track 名前 [--mute\|--unmute\|--solo\|--unsolo\|--volume -6\|--rename X\|--delete]` | トラック操作。`--delete` はAIが作ったトラックだけ |
| `$R markers --region "サビ:17-24" --marker "ブレイク:32"` | 構成をリージョンで書き込む |
| `$R fx --instruments [--filter piano]` / `$R addfx トラック "音源名"` | 音源の一覧と追加 |
| `$R view file.mid\|file.json` / `$R mid part.json out.mid` | REAPERなしで表示・.mid書き出し |
| `$R lua -e 'code'` / `$R call op '{json}'` | 上にない操作(下の「lua操作」参照) |

終了コード: 0 成功 / 1 REAPER側のエラー / 2 入力の誤り / 3 ブリッジが動いていない。

## Phase 0: 毎回の準備

1. `$R status`
   - 終了コード3なら、ユーザーに次をお願いする:
     「REAPERで Actions → Show action list を開き、`ai_bridge.lua` を選んで Run してください」。
     初回は「New action → Load ReaScript...」で `~/Library/Application Support/REAPER/Scripts/ReaperAI/ai_bridge.lua` を読み込む。
   - それでも繋がらないときは、Cubase/REAPERから `.mid` を書き出してもらい、`$R view` で分析する「ファイルモード」で進められる。
2. 初回だけ `$R selftest`。NGが出たら、その結果を見せて ai_bridge.lua の時間変換を直す。
3. 作業フォルダ(通常 `~/ReaperAI`)の `PREFERENCES.md`(ユーザーの好み・持っている音源)と、
   取り組む曲の `songs/<曲のslug>/NOTES.md` を読む。なければ Phase 1 のあとで作る。

## Phase 1: 読む・分析を伝える

1. `$R project` で全体を把握し、`$R read`(ユーザーが選択したアイテム)か `$R read --track <名前>` でMIDIを読む。
   長いテイクは `--summary` で全体を見てから `--bars` で区切って `--detail` を読む。
2. 出力の `key (推定)` と `chords (推定)` は**機械的な推定**なので、ノートの一覧で必ず確かめてから語る。
   特に分数コード、テンション、経過音、ペダルで濁った箇所は自分で読み直す。音名は C4=60(REAPER表記)。
   ユーザーはCubase出身なので、ノート番号の話をするときは「Cubase表記ではC3」と添える。
3. 分析は短く、具体的に、小節番号を添えて伝える。観点は `references/arrangement.md` の「分析の観点」。例:
   - 「キーはAマイナー。1〜4小節は Am → F → C → G の循環で、3小節目で旋律がE5まで跳躍してピークになっています」
   - 「左手は8分の分散和音で、ペダルを毎小節踏み替えています。ハーモニックリズムは1小節1コード」
4. 方向性を**1〜2個だけ**質問する(ジャンル・雰囲気・参考曲・この部分は曲のどこか・どこまで広げたいか)。
   質問攻めにしない。

## Phase 2: 提案する

- 選択肢は2〜3個。それぞれに**音楽的な理由**と**何がどう変わるか**(どの小節の何を)と**狙う効果**を書く。
  例: 「案A: 4小節目の G を G/B にしてベースを C→B→A と順次下降させる。サビ前の推進力は残したまま滑らかになります」
- 一度に変えるのは1パート、または1セクションまで。小さく作って聴いてもらう。
- アレンジの引き出しは `references/arrangement.md`、音色とドラムの番号は `references/gm.md`。

## Phase 3: 書く

1. パートをJSONで書く(形式は下)。ファイルは `songs/<slug>/parts/<パート>-v<N>.json` に保存する
   (あとで比べたり戻したりできる)。不安があれば `$R write ファイル --dry-run` で中身を確かめる。
2. `$R write ファイル` で書き込む。
3. `$R play --bar <聴いてほしい小節>` で再生し、**どこを聴いてほしいか**を具体的に伝える
   (例: 「5〜8小節、ベースが歌の下で動きすぎていないか」)。

### 守ること

- **ユーザーが弾いたテイクは勝手に書き換えない。** 新しい案は必ず新しいトラック `<パート> v<N> (AI)` に書く。
  前の版は消さずに `$R track "Bass v1 (AI)" --mute` で残し、聴き比べられるようにする。
- ユーザーのテイク自体を直す(クオンタイズ・ボイシング修正など)ときは、何をどう変えるかを先に説明して
  同意を得てから `replace_item` を使う。すべての書き込みは REAPER の Undo 1回ぶんにまとまり、Cmd+Z で戻せると伝える。
- **Claudeは音を聴けない。** 「いい感じに聴こえます」とは言わない。判断はノートと理論から行い、
  聴いた感想はユーザーに聞く。音色・ミックスの良し悪しは、ユーザーの言葉で教えてもらう。
- 新しいトラックには音源を付ける。ユーザーの音源が `PREFERENCES.md` にあればそれを、なければ
  Mac標準の `"instrument": "AUi: DLSMusicDevice (Apple)"` と GM の `program` でスケッチする。
  音源名が通らなければ `$R fx --instruments` で正確な名前を探す。
- ベロシティは一律にしない。拍の強弱とフレーズの山に合わせて揺らす(`references/arrangement.md` の「人間らしさ」)。

## Phase 4: 聴いた感想を受けて直す・記録する

- 感想を音楽の言葉に翻訳して確認してから直す(「重い」→ 音域が低い/音数が多い/ベロシティが強い、のどれか)。
- 直した案は v<N+1> として新しいトラックに書く。採用が決まったら、古い版を消すかどうかユーザーに聞く。
- 区切りごとに `NOTES.md` を更新する(決めたこと、却下した案とその理由、次にやること)。
  構成が決まったら `$R markers --region` で REAPER にもリージョンを入れる。
- 好みや持っている音源など、曲をまたいで役立つことは `PREFERENCES.md` に書く。

## MIDIのJSON形式(`$R write` に渡す)

```json
{
  "track": "Bass v1 (AI)",
  "after": "Piano",
  "instrument": "AUi: DLSMusicDevice (Apple)",
  "program": 33,
  "name": "Aメロ ベース案A",
  "notes": [
    {"bar": 1, "beat": 1,   "len": 1.5, "pitch": "C2", "vel": 92},
    {"bar": 1, "beat": 2.5, "len": 0.5, "pitch": "G1", "vel": 74},
    {"bar": 2, "beat": 1,   "len": 4,   "pitch": 33,   "vel": 88}
  ],
  "cc": [
    {"bar": 1, "beat": 1, "cc": 64, "val": 127},
    {"bar": 1, "beat": 4.9, "cc": 64, "val": 0}
  ]
}
```

| フィールド | 意味 |
|---|---|
| `track` | 書き込むトラック名。なければ作る(AIが作った印が付く) |
| `after` | 新しいトラックをこのトラックの直後に置く |
| `bar` / `beat` | 小節(1始まり)と拍(1始まり、小数可)。拍は拍子の分母の単位(4/4なら四分、6/8なら八分) |
| `len` | 長さ。**常に四分音符単位**(1 = 四分、0.5 = 八分、1.5 = 付点四分、4 = 全音符) |
| `pitch` | `"C4"`(=60), `"Bb2"`, `"F#3"`, 数値, またはドラム名 `"kick"` `"snare"` `"closed_hh"` など |
| `vel` | 1〜127(省略時96) |
| `ch` | MIDIチャンネル1〜16(省略時1)。GMのドラムは10 |
| `program` | アイテム先頭に入れるプログラムチェンジ(0〜127 = GMの番号−1) |
| `cc` | `{"cc": 64, "val": 127}`、`{"type": "pc", "val": 48}`、`{"type": "pb", "val": -8192..8191}` |
| `start_bar` / `end_bar` | アイテムの範囲を指定したいとき(省略時は音のある小節ぴったり) |
| `start` | `bar`/`beat` の代わりに、曲頭からの四分音符数で位置を指定 |
| `replace_item` | 既存アイテムのGUID。ノートを入れ替える(同意を得てから)。`clear_cc: true` でCCも消す |

複数パートを一度に書くときは `{"parts": [{...}, {...}]}`。トップレベルの `instrument` / `after` は全パートの既定値になる。
`timesig` / `tempo` は `view` / `mid` / `--dry-run` のときだけ使われる(REAPERへの書き込みはプロジェクトの拍子に従う)。

## lua操作(上のコマンドでできないこと)

`$R lua -e '...'` は REAPER の中で任意の ReaScript を実行する(`reaper` API、`json`、
ヘルパー `ai.find_track` / `ai.qn_to_barbeat` / `ai.barbeat_to_qn` / `ai.bar_info` / `ai.midi_take` が使える)。
テンポ変更、FXのパラメータ、レンダリングなどに使う。

- 実行前に、何をするコードかをユーザーに一言で伝える。
- ファイルの削除、`os.execute`、REAPERの設定変更はしない。
- 繰り返し使う操作になったら、ai_bridge.lua に op として足すことを提案する(足したらREAPERでスクリプトを再実行)。

## 曲ノート(`songs/<slug>/NOTES.md`)のひな形

```markdown
# <曲名(仮)>

- REAPERプロジェクト: <パス>
- コンセプト: <ユーザーの言葉のまま>
- 雰囲気・参考曲:
- キー / テンポ / 拍子:
- 構成: | Intro 1-4 | A 5-12 | B 13-20 | サビ 21-28 |
- コード進行(確定):
- トラック: Piano(ユーザー、原案) / Bass v2 (AI)(採用) / ...

## 決めたこと
- 2026-10-10 サビ頭は IVmaj7 から。王道進行で、v1のI始まりより開放感がある(ユーザー)

## 試して却下したこと
- ベースの16分刻み: 歌より目立つ

## 次にやること
- Bメロの最後に1小節のブレイクを試す
```

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `status` が終了コード3 | REAPERでブリッジを実行してもらう(Phase 0)。インストール時に `--autostart` を付けると、REAPER起動時に自動で立ち上がる |
| 応答が遅い・時々タイムアウトする | REAPERが裏に回ると macOS の App Nap でタイマーが間引かれることがある。REAPERを前面に出すか、`defaults write com.cockos.reaper NSAppSleepDisabled -bool YES` を案内する |
| 書いたのに音が出ない | トラックに音源があるか `$R project` の fx 欄で確認。なければ `$R addfx` |
| 音名が1オクターブずれて見える | REAPERは C4=60、Cubaseは C3=60。どちらの表記かを確かめる |
| ブリッジがエラーを返す | エラー文を読み、必要なら `reaper/ai_bridge.lua` を直す。直したら `~/Library/Application Support/REAPER/Scripts/ReaperAI/` にコピーし、REAPERでスクリプトを再実行してもらう |
