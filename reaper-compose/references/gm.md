# General MIDI の音色とドラム

Macでは標準の `AUi: DLSMusicDevice (Apple)` がGM音源として鳴る。スケッチ用。

## プログラム番号(`program` に入れる値 = GMの番号 − 1)

| program | 音色 | program | 音色 |
|---|---|---|---|
| 0 | Acoustic Grand Piano | 48 | String Ensemble 1 |
| 1 | Bright Acoustic Piano | 49 | String Ensemble 2 (slow) |
| 4 | Electric Piano 1 (Rhodes系) | 50 | Synth Strings 1 |
| 5 | Electric Piano 2 (FM系) | 52 | Choir Aahs |
| 6 | Harpsichord | 53 | Voice Oohs |
| 7 | Clavinet | 56 | Trumpet |
| 8 | Celesta | 57 | Trombone |
| 10 | Music Box | 60 | French Horn |
| 11 | Vibraphone | 61 | Brass Section |
| 12 | Marimba | 65 | Alto Sax |
| 16 | Drawbar Organ | 66 | Tenor Sax |
| 19 | Church Organ | 68 | Oboe |
| 21 | Accordion | 71 | Clarinet |
| 24 | Nylon Guitar | 73 | Flute |
| 25 | Steel Guitar | 75 | Pan Flute |
| 26 | Jazz Guitar | 80 | Lead 1 (square) |
| 27 | Clean Guitar | 81 | Lead 2 (sawtooth) |
| 28 | Muted Guitar | 88 | Pad 1 (new age) |
| 29 | Overdriven Guitar | 89 | Pad 2 (warm) |
| 30 | Distortion Guitar | 90 | Pad 3 (polysynth) |
| 32 | Acoustic Bass (ウッド) | 91 | Pad 4 (choir) |
| 33 | Electric Bass (finger) | 92 | Pad 5 (bowed) |
| 34 | Electric Bass (pick) | 94 | Pad 7 (halo) |
| 35 | Fretless Bass | 95 | Pad 8 (sweep) |
| 36 | Slap Bass 1 | 107 | Koto |
| 38 | Synth Bass 1 | 108 | Kalimba |
| 40 | Violin | 112 | Tinkle Bell |
| 41 | Viola | 114 | Steel Drums |
| 42 | Cello | 116 | Taiko Drum |
| 44 | Tremolo Strings | 119 | Reverse Cymbal |
| 45 | Pizzicato Strings | | |
| 46 | Orchestral Harp | | |
| 47 | Timpani | | |

## ドラム(ch 10)

`pitch` には番号か名前(左の列)を書ける。

| 名前 | 番号 | 楽器 |
|---|---|---|
| `kick2` | 35 | Acoustic Bass Drum |
| `kick` / `bd` | 36 | Bass Drum 1 |
| `rim` / `sidestick` | 37 | Side Stick |
| `snare` / `sd` | 38 | Acoustic Snare |
| `clap` | 39 | Hand Clap |
| `snare2` | 40 | Electric Snare |
| `floor_tom` | 41 | Low Floor Tom |
| `closed_hh` / `chh` | 42 | Closed Hi-Hat |
| `high_floor_tom` | 43 | High Floor Tom |
| `pedal_hh` | 44 | Pedal Hi-Hat |
| `low_tom` | 45 | Low Tom |
| `open_hh` / `ohh` | 46 | Open Hi-Hat |
| `mid_tom` / `low_mid_tom` | 47 | Low-Mid Tom |
| `high_mid_tom` | 48 | Hi-Mid Tom |
| `crash` | 49 | Crash Cymbal 1 |
| `high_tom` | 50 | High Tom |
| `ride` | 51 | Ride Cymbal 1 |
| `china` | 52 | Chinese Cymbal |
| `ride_bell` | 53 | Ride Bell |
| `tambourine` | 54 | Tambourine |
| `splash` | 55 | Splash Cymbal |
| `cowbell` | 56 | Cowbell |
| `crash2` | 57 | Crash Cymbal 2 |
| `ride2` | 59 | Ride Cymbal 2 |
| `high_conga` | 62 | Mute Hi Conga |
| `low_conga` | 64 | Low Conga |
| `shaker` / `maracas` | 70 | Maracas |
| `claves` | 75 | Claves |
| `high_wood` / `low_wood` | 76 / 77 | Wood Block |
| `triangle` | 81 | Open Triangle |

## 8ビートの例(1小節、4/4)

```json
{"track": "Drums v1 (AI)", "instrument": "AUi: DLSMusicDevice (Apple)", "notes": [
  {"bar": 1, "beat": 1,   "len": 0.25, "pitch": "kick",      "ch": 10, "vel": 100},
  {"bar": 1, "beat": 3,   "len": 0.25, "pitch": "kick",      "ch": 10, "vel": 92},
  {"bar": 1, "beat": 3.5, "len": 0.25, "pitch": "kick",      "ch": 10, "vel": 80},
  {"bar": 1, "beat": 2,   "len": 0.25, "pitch": "snare",     "ch": 10, "vel": 100},
  {"bar": 1, "beat": 4,   "len": 0.25, "pitch": "snare",     "ch": 10, "vel": 104},
  {"bar": 1, "beat": 1,   "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 92},
  {"bar": 1, "beat": 1.5, "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 64},
  {"bar": 1, "beat": 2,   "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 88},
  {"bar": 1, "beat": 2.5, "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 62},
  {"bar": 1, "beat": 3,   "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 90},
  {"bar": 1, "beat": 3.5, "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 66},
  {"bar": 1, "beat": 4,   "len": 0.25, "pitch": "closed_hh", "ch": 10, "vel": 86},
  {"bar": 1, "beat": 4.5, "len": 0.25, "pitch": "open_hh",   "ch": 10, "vel": 70}
]}
```
