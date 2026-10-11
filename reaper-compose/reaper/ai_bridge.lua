-- ReaperAI Bridge
-- @version 0.1.0
--
-- Claude Code など外部のプロセスから REAPER を操作するための常駐スクリプト。
-- ~/ReaperAI/.bridge/inbox/*.json に置かれたリクエストを処理し、
-- 結果を ~/ReaperAI/.bridge/outbox/<同じ名前>.json に書き出す。
--
-- 使い方: Actions → Show action list → New action → Load ReaScript... でこのファイルを
-- 読み込んで実行する。もう一度実行すると前のインスタンスは自動で止まる。
--
-- 書き込み系の操作はすべて 1 回の Undo にまとまるので、Cmd+Z で取り消せる。

local BRIDGE_VERSION = "0.1.0"

-- 連携フォルダ。Python 側 (reaper_ai.py) の REAPER_AI_DIR と同じ場所を指すこと。
local BASE_DIR = REAPER_AI_DIR_OVERRIDE or ((os.getenv("HOME") or "") .. "/ReaperAI")

-- lua 操作 (任意の ReaScript を実行) を許可するか。
-- 許可すると、連携フォルダに書き込めるプロセスは REAPER 上で何でも実行できる。
local ALLOW_LUA = true

local POLL_INTERVAL = 0.1   -- 秒
local HEARTBEAT_INTERVAL = 1.0
local STALE_SECONDS = 30    -- これより古いリクエストは実行しない

local POS_EPS = 1e-6 -- 位置の比較に使う許容幅 (QN)
local END_EPS = 1e-4 -- 「終点の直前」を表すのに引く量 (QN, 1 tick より小さい)
local ROLL_EPS = 1e-7 -- 小節末の丸め誤差を次の小節に繰り上げる幅 (拍)

---------------------------------------------------------------------------
-- JSON
---------------------------------------------------------------------------

local json = {}
local ARRAY_MT, OBJECT_MT = {}, {}

function json.array(t) return setmetatable(t or {}, ARRAY_MT) end
function json.object(t) return setmetatable(t or {}, OBJECT_MT) end

local ESCAPES = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encode_string(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    return ESCAPES[c] or string.format("\\u%04x", c:byte())
  end) .. '"'
end

local function is_array(t)
  local mt = getmetatable(t)
  if mt == ARRAY_MT then return true end
  if mt == OBJECT_MT then return false end
  local n = 0
  for k in pairs(t) do
    if math.type(k) ~= "integer" or k < 1 then return false end
    n = n + 1
  end
  for i = 1, n do
    if t[i] == nil then return false end
  end
  return true -- 空テーブルは配列扱い
end

local function encode_value(v, out)
  local t = type(v)
  if v == nil then
    out[#out + 1] = "null"
  elseif t == "boolean" then
    out[#out + 1] = v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then
      out[#out + 1] = "null"
    elseif math.type(v) == "integer" then
      out[#out + 1] = string.format("%d", v)
    else
      out[#out + 1] = string.format("%.14g", v)
    end
  elseif t == "string" then
    out[#out + 1] = encode_string(v)
  elseif t == "table" then
    if is_array(v) then
      out[#out + 1] = "["
      for i = 1, #v do
        if i > 1 then out[#out + 1] = "," end
        encode_value(v[i], out)
      end
      out[#out + 1] = "]"
    else
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = tostring(k) end
      table.sort(keys)
      out[#out + 1] = "{"
      for i, k in ipairs(keys) do
        if i > 1 then out[#out + 1] = "," end
        out[#out + 1] = encode_string(k)
        out[#out + 1] = ":"
        local val = v[k]
        if val == nil then val = v[tonumber(k)] end
        encode_value(val, out)
      end
      out[#out + 1] = "}"
    end
  else
    out[#out + 1] = encode_string(tostring(v))
  end
end

function json.encode(v)
  local out = {}
  encode_value(v, out)
  return table.concat(out)
end

local function decode_error(pos, msg)
  error(string.format("JSON decode error at %d: %s", pos, msg), 0)
end

local function skip_ws(s, pos)
  return s:find("[^ \t\r\n]", pos) or (#s + 1)
end

local decode_value

local function decode_string(s, pos)
  -- pos は開きの '"'
  local out = {}
  local i = pos + 1
  while true do
    local j = s:find('["\\]', i)
    if not j then decode_error(pos, "unterminated string") end
    out[#out + 1] = s:sub(i, j - 1)
    if s:sub(j, j) == '"' then
      return table.concat(out), j + 1
    end
    local c = s:sub(j + 1, j + 1)
    if c == "u" then
      local hex = s:sub(j + 2, j + 5)
      if not hex:match("^%x%x%x%x$") then decode_error(j, "bad \\u escape") end
      local cp = tonumber(hex, 16)
      local nexti = j + 6
      if cp >= 0xD800 and cp <= 0xDBFF and s:sub(nexti, nexti + 1) == "\\u" then
        local lo = tonumber(s:sub(nexti + 2, nexti + 5), 16)
        if lo and lo >= 0xDC00 and lo <= 0xDFFF then
          cp = 0x10000 + (cp - 0xD800) * 0x400 + (lo - 0xDC00)
          nexti = nexti + 6
        end
      end
      out[#out + 1] = utf8.char(cp)
      i = nexti
    else
      local map = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
      local r = map[c]
      if not r then decode_error(j, "bad escape") end
      out[#out + 1] = r
      i = j + 2
    end
  end
end

local function decode_array(s, pos)
  local arr = json.array()
  pos = skip_ws(s, pos + 1)
  if s:sub(pos, pos) == "]" then return arr, pos + 1 end
  while true do
    local v
    v, pos = decode_value(s, pos)
    arr[#arr + 1] = v
    pos = skip_ws(s, pos)
    local c = s:sub(pos, pos)
    if c == "]" then return arr, pos + 1 end
    if c ~= "," then decode_error(pos, "expected ',' or ']'") end
    pos = skip_ws(s, pos + 1)
  end
end

local function decode_object(s, pos)
  local obj = {}
  pos = skip_ws(s, pos + 1)
  if s:sub(pos, pos) == "}" then return obj, pos + 1 end
  while true do
    if s:sub(pos, pos) ~= '"' then decode_error(pos, "expected string key") end
    local k
    k, pos = decode_string(s, pos)
    pos = skip_ws(s, pos)
    if s:sub(pos, pos) ~= ":" then decode_error(pos, "expected ':'") end
    local v
    v, pos = decode_value(s, skip_ws(s, pos + 1))
    obj[k] = v
    pos = skip_ws(s, pos)
    local c = s:sub(pos, pos)
    if c == "}" then return obj, pos + 1 end
    if c ~= "," then decode_error(pos, "expected ',' or '}'") end
    pos = skip_ws(s, pos + 1)
  end
end

decode_value = function(s, pos)
  pos = skip_ws(s, pos)
  local c = s:sub(pos, pos)
  if c == "{" then return decode_object(s, pos) end
  if c == "[" then return decode_array(s, pos) end
  if c == '"' then return decode_string(s, pos) end
  if s:sub(pos, pos + 3) == "true" then return true, pos + 4 end
  if s:sub(pos, pos + 4) == "false" then return false, pos + 5 end
  if s:sub(pos, pos + 3) == "null" then return nil, pos + 4 end
  local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
  if num and num ~= "" then
    local n = tonumber(num)
    if n == nil then decode_error(pos, "bad number") end
    return n, pos + #num
  end
  decode_error(pos, "unexpected character '" .. c .. "'")
end

function json.decode(s)
  local v, pos = decode_value(s, 1)
  pos = skip_ws(s, pos)
  if pos <= #s then decode_error(pos, "trailing garbage") end
  return v
end

---------------------------------------------------------------------------
-- 共通ヘルパー
---------------------------------------------------------------------------

local function fail(msg)
  error({ user = msg }, 0)
end

local function round(x, digits)
  local m = 10 ^ (digits or 4)
  return math.floor(x * m + 0.5) / m
end

local NOTE_NAMES = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }
local NOTE_INDEX = { C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11 }

-- C4 = 60
local function pitch_name(p)
  return NOTE_NAMES[p % 12 + 1] .. tostring(p // 12 - 1)
end

local function parse_pitch(v)
  if math.type(v) == "integer" then return v end
  if type(v) == "number" and v == math.floor(v) then return math.floor(v) end
  if type(v) ~= "string" then return nil end
  local letter, acc, oct = v:match("^%s*([A-Ga-g])([#b♯♭]*)(-?%d+)%s*$")
  if not letter then return nil end
  local pc = NOTE_INDEX[letter:upper()]
  for ch in acc:gmatch("[#b]") do pc = pc + (ch == "#" and 1 or -1) end
  for _ in acc:gmatch("♯") do pc = pc + 1 end
  for _ in acc:gmatch("♭") do pc = pc - 1 end
  return (tonumber(oct) + 1) * 12 + pc
end

local function track_name(tr)
  local _, name = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  return name or ""
end

local function track_guid(tr)
  local _, g = reaper.GetSetMediaTrackInfo_String(tr, "GUID", "", false)
  return g or ""
end

local function track_is_ai(tr)
  local _, v = reaper.GetSetMediaTrackInfo_String(tr, "P_EXT:reaper_ai", "", false)
  return v == "1"
end

local function item_guid(item)
  local _, g = reaper.GetSetMediaItemInfo_String(item, "GUID", "", false)
  return g or ""
end

local function track_number(tr)
  return math.floor(reaper.GetMediaTrackInfo_Value(tr, "IP_TRACKNUMBER"))
end

local function find_track(spec)
  local n = reaper.CountTracks(0)
  if type(spec) == "number" then
    if spec >= 1 and spec <= n then return reaper.GetTrack(0, math.floor(spec) - 1) end
    return nil
  end
  if type(spec) ~= "string" or spec == "" then return nil end
  for i = 0, n - 1 do
    local tr = reaper.GetTrack(0, i)
    if track_name(tr) == spec or track_guid(tr) == spec then return tr end
  end
  local lower = spec:lower()
  for i = 0, n - 1 do
    local tr = reaper.GetTrack(0, i)
    if track_name(tr):lower() == lower then return tr end
  end
  return nil
end

local function require_track(spec)
  local tr = find_track(spec)
  if not tr then fail("トラックが見つかりません: " .. tostring(spec)) end
  return tr
end

local function find_item(guid)
  for i = 0, reaper.CountMediaItems(0) - 1 do
    local item = reaper.GetMediaItem(0, i)
    if item_guid(item) == guid then return item end
  end
  return nil
end

local function fx_names(tr)
  local names = json.array()
  for i = 0, reaper.TrackFX_GetCount(tr) - 1 do
    local _, name = reaper.TrackFX_GetFXName(tr, i, "")
    names[#names + 1] = name
  end
  return names
end

---------------------------------------------------------------------------
-- 時間変換 (QN = 四分音符単位のプロジェクト位置)
---------------------------------------------------------------------------

-- QN → 小節 (1 始まり), 拍 (1 始まり、拍子の分母単位), 拍子
local function qn_to_barbeat(qn)
  local t = reaper.TimeMap2_QNToTime(0, qn)
  local beat, measures, cml, _, cdenom = reaper.TimeMap2_timeToBeats(0, t)
  if beat + ROLL_EPS >= cml then
    measures, beat = measures + 1, 0
  end
  if beat < ROLL_EPS then beat = 0 end
  return measures + 1, beat + 1, cml, cdenom
end

-- 小節の開始 QN、終了 QN、拍子
local function bar_info(bar)
  local _, qn_start, qn_end, num, denom, tempo = reaper.TimeMap_GetMeasureInfo(0, math.floor(bar) - 1)
  return qn_start, qn_end, num, denom, tempo
end

local function barbeat_to_qn(bar, beat)
  local qn_start, _, _, denom = bar_info(bar)
  return qn_start + ((beat or 1) - 1) * 4 / denom
end

local function bar_of_qn(qn)
  return (qn_to_barbeat(qn))
end

-- note/cc などの {start | bar, beat} を QN に
local function event_qn(ev, label)
  if type(ev.start) == "number" then return ev.start end
  if type(ev.bar) == "number" then
    if ev.bar < 1 then fail(label .. ": bar は 1 以上です") end
    local beat = ev.beat
    if beat ~= nil and type(beat) ~= "number" then fail(label .. ": beat は数値で指定してください") end
    return barbeat_to_qn(ev.bar, beat or 1)
  end
  fail(label .. ": start (QN) か bar/beat が必要です")
end

local function timesig_at_qn(qn)
  local num, denom, tempo = reaper.TimeMap_GetTimeSigAtTime(0, reaper.TimeMap2_QNToTime(0, qn))
  return num, denom, tempo
end

---------------------------------------------------------------------------
-- MIDI 読み出し
---------------------------------------------------------------------------

local function read_take(item, take, range_start, range_end)
  local tr = reaper.GetMediaItem_Track(item)
  local pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
  local len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
  local item_start_qn = reaper.TimeMap2_timeToQN(0, pos)
  local item_end_qn = reaper.TimeMap2_timeToQN(0, pos + len)
  local lo = math.max(item_start_qn, range_start or -math.huge)
  local hi = math.min(item_end_qn, range_end or math.huge)

  local notes, ccs = json.array(), json.array()
  local _, note_count, cc_count = reaper.MIDI_CountEvts(take)
  for i = 0, note_count - 1 do
    local ok, sel, muted, sppq, eppq, chan, pitch, vel = reaper.MIDI_GetNote(take, i)
    if ok then
      local s = reaper.MIDI_GetProjQNFromPPQPos(take, sppq)
      local e = reaper.MIDI_GetProjQNFromPPQPos(take, eppq)
      if s >= lo - POS_EPS and s < hi - POS_EPS then
        local bar, beat = qn_to_barbeat(s)
        notes[#notes + 1] = {
          pitch = pitch, name = pitch_name(pitch),
          start = round(s, 5), len = round(e - s, 5),
          bar = bar, beat = round(beat, 4),
          vel = vel, ch = chan + 1,
          muted = muted or nil, sel = sel or nil,
        }
      end
    end
  end
  for i = 0, cc_count - 1 do
    local ok, _, muted, ppq, chanmsg, chan, msg2, msg3 = reaper.MIDI_GetCC(take, i)
    if ok then
      local s = reaper.MIDI_GetProjQNFromPPQPos(take, ppq)
      if s >= lo - POS_EPS and s < hi - POS_EPS then
        local bar, beat = qn_to_barbeat(s)
        local ev = { start = round(s, 5), bar = bar, beat = round(beat, 4), ch = chan + 1, muted = muted or nil }
        if chanmsg == 0xB0 then
          ev.type, ev.cc, ev.val = "cc", msg2, msg3
        elseif chanmsg == 0xC0 then
          ev.type, ev.val = "pc", msg2
        elseif chanmsg == 0xE0 then
          ev.type, ev.val = "pb", msg3 * 128 + msg2 - 8192
        else
          ev.type, ev.status, ev.d1, ev.d2 = "other", chanmsg, msg2, msg3
        end
        ccs[#ccs + 1] = ev
      end
    end
  end

  local _, take_name = reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "", false)
  local num, denom, tempo = timesig_at_qn(item_start_qn)
  local start_bar = bar_of_qn(item_start_qn)
  local end_bar = bar_of_qn(math.max(item_start_qn, item_end_qn - END_EPS))

  -- 解析用の小節グリッド (読み出し範囲ぶん)
  local bars = json.array()
  for b = bar_of_qn(lo), bar_of_qn(math.max(lo, hi - END_EPS)) do
    local qs, qe, bnum, bdenom = bar_info(b)
    bars[#bars + 1] = { bar = b, start = round(qs, 5), ["end"] = round(qe, 5), num = bnum, denom = bdenom }
  end
  return {
    track = track_name(tr), track_number = track_number(tr), track_guid = track_guid(tr),
    item = item_guid(item), take_name = take_name or "",
    start_qn = round(item_start_qn, 5), end_qn = round(item_end_qn, 5),
    start_bar = start_bar, end_bar = end_bar,
    muted = reaper.GetMediaItemInfo_Value(item, "B_MUTE") == 1,
    timesig = json.array({ num, denom }), tempo = round(tempo, 3),
    bars = bars, notes = notes, cc = ccs,
  }
end

local function midi_take(item)
  local take = reaper.GetActiveTake(item)
  if take and reaper.TakeIsMIDI(take) then return take end
  return nil
end

---------------------------------------------------------------------------
-- 操作 (ops)
---------------------------------------------------------------------------

local OPS, MUTATING = {}, {}
local M_HELPERS -- lua 操作から使えるヘルパー (下で定義)

function OPS.ping()
  return {
    bridge_version = BRIDGE_VERSION,
    reaper_version = reaper.GetAppVersion(),
    project = reaper.GetProjectName(0, ""),
    base_dir = BASE_DIR,
    allow_lua = ALLOW_LUA,
  }
end

function OPS.project()
  local tracks = json.array()
  for i = 0, reaper.CountTracks(0) - 1 do
    local tr = reaper.GetTrack(0, i)
    local n_items, n_midi = reaper.CountTrackMediaItems(tr), 0
    local first_qn, last_qn
    for j = 0, n_items - 1 do
      local item = reaper.GetTrackMediaItem(tr, j)
      if midi_take(item) then n_midi = n_midi + 1 end
      local pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
      local len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
      local s, e = reaper.TimeMap2_timeToQN(0, pos), reaper.TimeMap2_timeToQN(0, pos + len)
      if not first_qn or s < first_qn then first_qn = s end
      if not last_qn or e > last_qn then last_qn = e end
    end
    tracks[#tracks + 1] = {
      number = i + 1, name = track_name(tr), guid = track_guid(tr),
      items = n_items, midi_items = n_midi,
      first_bar = first_qn and bar_of_qn(first_qn) or nil,
      last_bar = last_qn and bar_of_qn(math.max(first_qn, last_qn - END_EPS)) or nil,
      fx = fx_names(tr),
      mute = reaper.GetMediaTrackInfo_Value(tr, "B_MUTE") == 1,
      solo = reaper.GetMediaTrackInfo_Value(tr, "I_SOLO") > 0,
      ai = track_is_ai(tr),
    }
  end

  local markers = json.array()
  local _, n_markers, n_regions = reaper.CountProjectMarkers(0)
  for i = 0, n_markers + n_regions - 1 do
    local ok, isrgn, pos, rgnend, name, idx = reaper.EnumProjectMarkers3(0, i)
    if ok and ok > 0 then
      local qn = reaper.TimeMap2_timeToQN(0, pos)
      local bar, beat = qn_to_barbeat(qn)
      local m = { name = name, index = idx, region = isrgn, bar = bar, beat = round(beat, 3) }
      if isrgn then
        local end_qn = reaper.TimeMap2_timeToQN(0, rgnend)
        m.end_bar = bar_of_qn(math.max(qn, end_qn - END_EPS))
      end
      markers[#markers + 1] = m
    end
  end

  local tempo_map = json.array()
  for i = 0, reaper.CountTempoTimeSigMarkers(0) - 1 do
    local ok, timepos, _, _, bpm, num, denom = reaper.GetTempoTimeSigMarker(0, i)
    if ok then
      local bar, beat = qn_to_barbeat(reaper.TimeMap2_timeToQN(0, timepos))
      tempo_map[#tempo_map + 1] = {
        bar = bar, beat = round(beat, 3), bpm = round(bpm, 3),
        num = num > 0 and num or nil, denom = denom > 0 and denom or nil,
      }
    end
  end

  local num, denom, tempo = reaper.TimeMap_GetTimeSigAtTime(0, 0)
  local cursor_bar, cursor_beat = qn_to_barbeat(reaper.TimeMap2_timeToQN(0, reaper.GetCursorPosition()))
  local ts_start, ts_end = reaper.GetSet_LoopTimeRange2(0, false, false, 0, 0, false)
  local time_selection
  if ts_end > ts_start then
    local s = reaper.TimeMap2_timeToQN(0, ts_start)
    local e = reaper.TimeMap2_timeToQN(0, ts_end)
    local sb, sbeat = qn_to_barbeat(s)
    local eb, ebeat = qn_to_barbeat(e)
    time_selection = { start_bar = sb, start_beat = round(sbeat, 3), end_bar = eb, end_beat = round(ebeat, 3) }
  end
  local length = reaper.GetProjectLength(0)

  return {
    name = reaper.GetProjectName(0, ""),
    tempo = round(tempo, 3), timesig = json.array({ num, denom }),
    tempo_map = tempo_map,
    length_bars = length > 0 and bar_of_qn(reaper.TimeMap2_timeToQN(0, length) - END_EPS) or 0,
    cursor = { bar = cursor_bar, beat = round(cursor_beat, 3) },
    time_selection = time_selection,
    playing = (reaper.GetPlayState() & 1) == 1,
    selected_items = reaper.CountSelectedMediaItems(0),
    tracks = tracks,
    markers = markers,
  }
end

-- args: track | item | (選択アイテム), start_bar, end_bar (両端含む)
function OPS.read_midi(args)
  local range_start, range_end
  if args.start_bar then range_start = bar_info(args.start_bar) end
  if args.end_bar then local _, e = bar_info(args.end_bar); range_end = e end

  local items = {}
  if args.item then
    local item = find_item(args.item)
    if not item then fail("アイテムが見つかりません: " .. tostring(args.item)) end
    items[1] = item
  elseif args.track then
    local tr = require_track(args.track)
    for j = 0, reaper.CountTrackMediaItems(tr) - 1 do
      items[#items + 1] = reaper.GetTrackMediaItem(tr, j)
    end
  else
    for j = 0, reaper.CountSelectedMediaItems(0) - 1 do
      items[#items + 1] = reaper.GetSelectedMediaItem(0, j)
    end
    if #items == 0 then
      fail("読み込むアイテムがありません。REAPER でアイテムを選択するか、track を指定してください")
    end
  end

  local out = json.array()
  for _, item in ipairs(items) do
    local take = midi_take(item)
    if take then
      local pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
      local len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
      local s, e = reaper.TimeMap2_timeToQN(0, pos), reaper.TimeMap2_timeToQN(0, pos + len)
      if (not range_end or s < range_end) and (not range_start or e > range_start) then
        out[#out + 1] = read_take(item, take, range_start, range_end)
      end
    end
  end
  if #out == 0 then fail("指定範囲に MIDI アイテムがありません") end
  table.sort(out, function(a, b)
    if a.track_number ~= b.track_number then return a.track_number < b.track_number end
    return a.start_qn < b.start_qn
  end)
  return { items = out }
end

local function validate_events(args)
  local notes, ccs, problems = {}, {}, {}
  local function problem(msg)
    if #problems < 10 then problems[#problems + 1] = msg end
  end
  for i, n in ipairs(args.notes or {}) do
    local label = "notes[" .. i .. "]"
    local ok, err = pcall(function()
      local pitch = parse_pitch(n.pitch)
      if not pitch or pitch < 0 or pitch > 127 then fail(label .. ": pitch が不正です (" .. tostring(n.pitch) .. ")") end
      local s = event_qn(n, label)
      local len = n.len
      if type(len) ~= "number" or len <= 0 then fail(label .. ": len (QN, >0) が必要です") end
      local vel = n.vel or 96
      if type(vel) ~= "number" or vel < 1 or vel > 127 then fail(label .. ": vel は 1-127 です") end
      local ch = n.ch or 1
      if type(ch) ~= "number" or ch < 1 or ch > 16 then fail(label .. ": ch は 1-16 です") end
      notes[#notes + 1] = { pitch = pitch, s = s, e = s + len, vel = math.floor(vel), ch = math.floor(ch) - 1 }
    end)
    if not ok then problem(type(err) == "table" and err.user or tostring(err)) end
  end
  for i, c in ipairs(args.cc or {}) do
    local label = "cc[" .. i .. "]"
    local ok, err = pcall(function()
      local s = event_qn(c, label)
      local ch = c.ch or 1
      if type(ch) ~= "number" or ch < 1 or ch > 16 then fail(label .. ": ch は 1-16 です") end
      local kind = c.type or "cc"
      local ev = { s = s, ch = math.floor(ch) - 1 }
      if kind == "cc" then
        if type(c.cc) ~= "number" or c.cc < 0 or c.cc > 127 then fail(label .. ": cc 番号 (0-127) が必要です") end
        if type(c.val) ~= "number" or c.val < 0 or c.val > 127 then fail(label .. ": val は 0-127 です") end
        ev.chanmsg, ev.msg2, ev.msg3 = 0xB0, math.floor(c.cc), math.floor(c.val)
      elseif kind == "pc" then
        if type(c.val) ~= "number" or c.val < 0 or c.val > 127 then fail(label .. ": program は 0-127 です") end
        ev.chanmsg, ev.msg2, ev.msg3 = 0xC0, math.floor(c.val), 0
      elseif kind == "pb" then
        if type(c.val) ~= "number" or c.val < -8192 or c.val > 8191 then fail(label .. ": pitch bend は -8192..8191 です") end
        local v = math.floor(c.val) + 8192
        ev.chanmsg, ev.msg2, ev.msg3 = 0xE0, v % 128, v // 128
      else
        fail(label .. ": type は cc / pc / pb のいずれかです")
      end
      ccs[#ccs + 1] = ev
    end)
    if not ok then problem(type(err) == "table" and err.user or tostring(err)) end
  end
  if #problems > 0 then fail("入力に誤りがあります:\n- " .. table.concat(problems, "\n- ")) end
  if #notes == 0 and #ccs == 0 then fail("notes も cc も空です") end
  return notes, ccs
end

local function create_track(name, after)
  local idx = reaper.CountTracks(0)
  if after then
    local ref = require_track(after)
    idx = track_number(ref) -- ref の直後
  end
  reaper.InsertTrackAtIndex(idx, false)
  local tr = reaper.GetTrack(0, idx)
  reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", name, true)
  reaper.GetSetMediaTrackInfo_String(tr, "P_EXT:reaper_ai", "1", true)
  return tr
end

-- 新しい MIDI アイテムを書き込む、または既存アイテムの中身を置き換える
-- args: track, notes, cc, after, create(=true), replace_item, clear_cc,
--       start_bar, end_bar, name, program, program_ch, instrument
function OPS.write_midi(args)
  local notes, ccs = validate_events(args)
  local warnings = json.array()

  local first, last = math.huge, -math.huge
  for _, n in ipairs(notes) do first = math.min(first, n.s); last = math.max(last, n.e) end
  for _, c in ipairs(ccs) do first = math.min(first, c.s); last = math.max(last, c.s) end
  if first < 0 then fail("プロジェクト先頭より前にイベントがあります") end

  local item, take, tr, created_track
  if args.replace_item then
    item = find_item(args.replace_item)
    if not item then fail("アイテムが見つかりません: " .. tostring(args.replace_item)) end
    take = midi_take(item)
    if not take then fail("MIDI アイテムではありません: " .. tostring(args.replace_item)) end
    tr = reaper.GetMediaItem_Track(item)
    local _, n_notes, n_ccs = reaper.MIDI_CountEvts(take)
    for i = n_notes - 1, 0, -1 do reaper.MIDI_DeleteNote(take, i) end
    if args.clear_cc then
      for i = n_ccs - 1, 0, -1 do reaper.MIDI_DeleteCC(take, i) end
    end
    local pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
    local len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
    local s, e = reaper.TimeMap2_timeToQN(0, pos), reaper.TimeMap2_timeToQN(0, pos + len)
    if first < s - POS_EPS or last > e + POS_EPS then
      local _, bar_end = bar_info(bar_of_qn(math.max(first, last - END_EPS)))
      local bar_start = (bar_info(bar_of_qn(first)))
      reaper.MIDI_SetItemExtents(item, math.min(s, bar_start), math.max(e, bar_end))
    end
  else
    if type(args.track) ~= "string" or args.track == "" then fail("track (トラック名) が必要です") end
    tr = find_track(args.track)
    if not tr then
      if args.create == false then fail("トラックが見つかりません: " .. args.track) end
      tr = create_track(args.track, args.after)
      created_track = true
    end
    local start_qn = args.start_bar and bar_info(args.start_bar) or bar_info(bar_of_qn(first))
    local end_qn
    if args.end_bar then
      local _, e = bar_info(args.end_bar)
      end_qn = e
    else
      local _, e = bar_info(bar_of_qn(math.max(first, last - END_EPS)))
      end_qn = e
    end
    if first < start_qn - POS_EPS then fail("start_bar より前にイベントがあります") end
    if last > end_qn + POS_EPS then fail("end_bar より後ろにイベントがあります") end
    if end_qn <= start_qn then fail("アイテムの長さが 0 です") end
    item = reaper.CreateNewMIDIItemInProj(tr, start_qn, end_qn, true)
    if not item then fail("MIDI アイテムを作成できませんでした") end
    take = reaper.GetActiveTake(item)
  end

  if args.name then
    reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", tostring(args.name), true)
  end

  local item_pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
  local item_start_qn = reaper.TimeMap2_timeToQN(0, item_pos)
  if args.program ~= nil then
    local p = args.program
    if type(p) ~= "number" or p < 0 or p > 127 then fail("program は 0-127 です (GM 番号 - 1)") end
    local ch = (args.program_ch or (notes[1] and notes[1].ch + 1) or 1) - 1
    local ppq = reaper.MIDI_GetPPQPosFromProjQN(take, item_start_qn)
    reaper.MIDI_InsertCC(take, false, false, ppq, 0xC0, ch, math.floor(p), 0)
  end
  for _, c in ipairs(ccs) do
    local ppq = reaper.MIDI_GetPPQPosFromProjQN(take, c.s)
    reaper.MIDI_InsertCC(take, false, false, ppq, c.chanmsg, c.ch, c.msg2, c.msg3)
  end
  for _, n in ipairs(notes) do
    local sppq = reaper.MIDI_GetPPQPosFromProjQN(take, n.s)
    local eppq = reaper.MIDI_GetPPQPosFromProjQN(take, n.e)
    reaper.MIDI_InsertNote(take, false, false, sppq, eppq, n.ch, n.pitch, n.vel, true)
  end
  reaper.MIDI_Sort(take)

  local instrument
  if args.instrument and reaper.TrackFX_GetCount(tr) == 0 then
    local idx = reaper.TrackFX_AddByName(tr, args.instrument, false, -1)
    if idx < 0 then
      warnings[#warnings + 1] = "音源を追加できませんでした: " .. tostring(args.instrument) .. " (list_fx で名前を確認してください)"
    else
      instrument = select(2, reaper.TrackFX_GetFXName(tr, idx, ""))
    end
  end

  local pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
  local len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
  local s, e = reaper.TimeMap2_timeToQN(0, pos), reaper.TimeMap2_timeToQN(0, pos + len)
  return {
    track = track_name(tr), track_number = track_number(tr), created_track = created_track or false,
    item = item_guid(item), replaced = args.replace_item and true or false,
    start_bar = bar_of_qn(s), end_bar = bar_of_qn(math.max(s, e - END_EPS)),
    notes = #notes, cc = #ccs, instrument = instrument, warnings = warnings,
  }
end
MUTATING.write_midi = "write MIDI"

-- args: track, mute, solo, rename, volume_db, delete, force
function OPS.track(args)
  local tr = require_track(args.track)
  local name = track_name(tr)
  if args.delete then
    if not track_is_ai(tr) and not args.force then
      fail("AI が作ったトラックではないので削除しません: " .. name .. " (本当に消すなら force: true)")
    end
    reaper.DeleteTrack(tr)
    return { deleted = name }
  end
  if args.mute ~= nil then reaper.SetMediaTrackInfo_Value(tr, "B_MUTE", args.mute and 1 or 0) end
  if args.solo ~= nil then reaper.SetMediaTrackInfo_Value(tr, "I_SOLO", args.solo and 2 or 0) end
  if type(args.volume_db) == "number" then
    reaper.SetMediaTrackInfo_Value(tr, "D_VOL", 10 ^ (args.volume_db / 20))
  end
  if type(args.rename) == "string" and args.rename ~= "" then
    reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", args.rename, true)
  end
  return {
    track = track_name(tr),
    mute = reaper.GetMediaTrackInfo_Value(tr, "B_MUTE") == 1,
    solo = reaper.GetMediaTrackInfo_Value(tr, "I_SOLO") > 0,
    volume_db = round(20 * math.log(math.max(reaper.GetMediaTrackInfo_Value(tr, "D_VOL"), 1e-9), 10), 2),
  }
end
MUTATING.track = "track"

-- args: regions = [{name, start_bar, end_bar}], markers = [{name, bar, beat}]
function OPS.add_markers(args)
  local added = json.array()
  for _, r in ipairs(args.regions or {}) do
    if type(r.start_bar) ~= "number" or type(r.end_bar) ~= "number" or r.end_bar < r.start_bar then
      fail("regions には start_bar と end_bar (両端含む) が必要です")
    end
    local s = reaper.TimeMap2_QNToTime(0, (bar_info(r.start_bar)))
    local _, e_qn = bar_info(r.end_bar)
    local e = reaper.TimeMap2_QNToTime(0, e_qn)
    local idx = reaper.AddProjectMarker2(0, true, s, e, tostring(r.name or ""), -1, 0)
    added[#added + 1] = { region = true, name = r.name, index = idx, start_bar = r.start_bar, end_bar = r.end_bar }
  end
  for _, m in ipairs(args.markers or {}) do
    if type(m.bar) ~= "number" then fail("markers には bar が必要です") end
    local t = reaper.TimeMap2_QNToTime(0, barbeat_to_qn(m.bar, m.beat or 1))
    local idx = reaper.AddProjectMarker2(0, false, t, 0, tostring(m.name or ""), -1, 0)
    added[#added + 1] = { region = false, name = m.name, index = idx, bar = m.bar }
  end
  return { added = added }
end
MUTATING.add_markers = "add markers"

-- args: action = play | stop | goto, bar, beat, loop_start_bar, loop_end_bar
function OPS.transport(args)
  local action = args.action or "play"
  if action == "stop" then
    reaper.OnStopButton()
    return { stopped = true }
  end
  if args.loop_start_bar and args.loop_end_bar then
    local s = reaper.TimeMap2_QNToTime(0, (bar_info(args.loop_start_bar)))
    local _, e_qn = bar_info(args.loop_end_bar)
    reaper.GetSet_LoopTimeRange2(0, true, true, s, reaper.TimeMap2_QNToTime(0, e_qn), false)
    reaper.GetSetRepeat(1)
  end
  if args.bar then
    reaper.SetEditCurPos2(0, reaper.TimeMap2_QNToTime(0, barbeat_to_qn(args.bar, args.beat or 1)), true, true)
  end
  if action == "play" then reaper.OnPlayButton() end
  local bar, beat = qn_to_barbeat(reaper.TimeMap2_timeToQN(0, reaper.GetCursorPosition()))
  return { action = action, cursor = { bar = bar, beat = round(beat, 3) } }
end

-- args: filter (部分一致), instruments (true なら音源のみ), limit
function OPS.list_fx(args)
  if not reaper.EnumInstalledFX then fail("この REAPER では EnumInstalledFX が使えません (REAPER 7 以降が必要)") end
  local filter = args.filter and tostring(args.filter):lower()
  local limit = args.limit or 200
  local out, total = json.array(), 0
  local i = 0
  while true do
    local ok, name, ident = reaper.EnumInstalledFX(i)
    if not ok then break end
    i = i + 1
    local is_inst = name:match("^%w+i:") ~= nil
    if (not args.instruments or is_inst) and (not filter or name:lower():find(filter, 1, true)) then
      total = total + 1
      if #out < limit then out[#out + 1] = { name = name, ident = ident, instrument = is_inst } end
    end
  end
  return { fx = out, total = total }
end

-- args: track, fx, show
function OPS.add_fx(args)
  local tr = require_track(args.track)
  if type(args.fx) ~= "string" then fail("fx (名前) が必要です") end
  local idx = reaper.TrackFX_AddByName(tr, args.fx, false, -1)
  if idx < 0 then fail("FX を追加できませんでした: " .. args.fx .. " (list_fx で名前を確認してください)") end
  if args.show then reaper.TrackFX_Show(tr, idx, 3) end
  return { track = track_name(tr), index = idx, fx = fx_names(tr) }
end
MUTATING.add_fx = "add FX"

-- args: code (Lua). reaper / json / ai (このブリッジのヘルパー) が使える。
-- return した値が result に入る。print した内容は output に入る。
function OPS.lua(args)
  if not ALLOW_LUA then fail("lua 操作は無効です (ai_bridge.lua の ALLOW_LUA)") end
  if type(args.code) ~= "string" then fail("code が必要です") end
  local output = {}
  local env = setmetatable({
    reaper = reaper, json = json, ai = M_HELPERS,
    print = function(...)
      local parts = {}
      for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
      output[#output + 1] = table.concat(parts, "\t")
    end,
  }, { __index = _G })
  local chunk, err = load(args.code, "=lua", "t", env)
  if not chunk then fail("Lua の構文エラー: " .. tostring(err)) end
  local ret = table.pack(chunk())
  local result = ret[1]
  if ret.n > 1 then result = json.array({ table.unpack(ret, 1, ret.n) }) end
  return { result = result, output = table.concat(output, "\n") }
end
MUTATING.lua = "Lua script"

-- 小節/拍の変換が REAPER の実装と噛み合っているかを確かめる
function OPS.selftest()
  local checks = json.array()
  local all_ok = true
  for bar = 1, 9 do
    for _, beat in ipairs({ 1, 2.5 }) do
      local qn = barbeat_to_qn(bar, beat)
      local b2, beat2 = qn_to_barbeat(qn)
      local ok = b2 == bar and math.abs(beat2 - beat) < 1e-4
      if beat == 2.5 then
        local _, _, num = bar_info(bar)
        if num < 3 then ok = true end
      end
      all_ok = all_ok and ok
      checks[#checks + 1] = { bar = bar, beat = beat, qn = round(qn, 5), back_bar = b2, back_beat = round(beat2, 5), ok = ok }
    end
  end
  local first_bar_qn = bar_info(1)
  local origin_ok = math.abs(first_bar_qn) < 1e-6
  return { ok = all_ok and origin_ok, bar1_qn = first_bar_qn, checks = checks }
end

M_HELPERS = {
  find_track = find_track, find_item = find_item, track_name = track_name,
  qn_to_barbeat = qn_to_barbeat, barbeat_to_qn = barbeat_to_qn, bar_info = bar_info,
  pitch_name = pitch_name, parse_pitch = parse_pitch, midi_take = midi_take,
}

---------------------------------------------------------------------------
-- リクエスト処理
---------------------------------------------------------------------------

local M = { json = json, ops = OPS, version = BRIDGE_VERSION, helpers = M_HELPERS }

local function error_message(err)
  if type(err) == "table" and err.user then return err.user end
  return debug.traceback(tostring(err), 2)
end

function M.handle(req)
  if type(req) ~= "table" then return { ok = false, error = "リクエストが JSON オブジェクトではありません" } end
  local op = OPS[req.op]
  if not op then
    local names = {}
    for k in pairs(OPS) do names[#names + 1] = k end
    table.sort(names)
    return { ok = false, error = "未知の op: " .. tostring(req.op) .. " (使えるもの: " .. table.concat(names, ", ") .. ")" }
  end
  local args = type(req.args) == "table" and req.args or {}
  local undo_desc = MUTATING[req.op]
  if undo_desc then
    reaper.Undo_BeginBlock2(0)
    reaper.PreventUIRefresh(1)
  end
  local ok, result = xpcall(op, error_message, args)
  if undo_desc then
    reaper.PreventUIRefresh(-1)
    local label = args.track and (" " .. tostring(args.track)) or ""
    reaper.Undo_EndBlock2(0, "AI: " .. undo_desc .. label, -1)
    reaper.UpdateArrange()
    reaper.TrackList_AdjustWindows(false)
  end
  if ok then return { ok = true, result = result } end
  return { ok = false, error = result }
end

local dirs = {}

function M.setup(base)
  dirs.base = base
  dirs.bridge = base .. "/.bridge"
  dirs.inbox = dirs.bridge .. "/inbox"
  dirs.outbox = dirs.bridge .. "/outbox"
  dirs.heartbeat = dirs.bridge .. "/heartbeat.json"
  reaper.RecursiveCreateDirectory(dirs.inbox, 0)
  reaper.RecursiveCreateDirectory(dirs.outbox, 0)
  return dirs
end

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local s = f:read("a")
  f:close()
  return s
end

local function write_atomic(path, content)
  local tmp = path .. ".tmp"
  local f = assert(io.open(tmp, "wb"))
  f:write(content)
  f:close()
  os.remove(path)
  assert(os.rename(tmp, path))
end

function M.process_inbox()
  reaper.EnumerateFiles(dirs.inbox, -1) -- ディレクトリのキャッシュを捨てる
  local names = {}
  local i = 0
  while true do
    local f = reaper.EnumerateFiles(dirs.inbox, i)
    if not f then break end
    if f:match("^[%w%-_]+%.json$") then names[#names + 1] = f end
    i = i + 1
  end
  table.sort(names)
  for _, f in ipairs(names) do
    local path = dirs.inbox .. "/" .. f
    local content = read_file(path)
    os.remove(path)
    if content then
      local ok, req = pcall(json.decode, content)
      local resp
      if not ok then
        resp = { ok = false, error = "リクエストの JSON が読めません: " .. tostring(req) }
      elseif type(req) == "table" and type(req.created) == "number" and os.time() - req.created > STALE_SECONDS then
        resp = { ok = false, error = "古いリクエストなので実行しませんでした" }
      else
        resp = M.handle(req)
      end
      resp.id = f:gsub("%.json$", "")
      local enc_ok, body = pcall(json.encode, resp)
      if not enc_ok then body = json.encode({ ok = false, id = resp.id, error = "結果を JSON にできません: " .. tostring(body) }) end
      write_atomic(dirs.outbox .. "/" .. f, body)
    end
  end
  return #names
end

function M.write_heartbeat(instance)
  write_atomic(dirs.heartbeat, json.encode({
    time = os.time(), version = BRIDGE_VERSION, instance = instance, base_dir = dirs.base,
  }))
end

function M.run()
  M.setup(BASE_DIR)
  local instance = string.format("%d-%d", os.time(), math.random(1, 1000000000))
  reaper.SetExtState("ReaperAI", "instance", instance, false)
  local last_poll, last_beat = 0, 0

  local function loop()
    -- 別のインスタンスが起動したらこちらは止まる
    if reaper.GetExtState("ReaperAI", "instance") ~= instance then return end
    local now = reaper.time_precise()
    if now - last_poll >= POLL_INTERVAL then
      last_poll = now
      local ok, err = pcall(M.process_inbox)
      if not ok then reaper.ShowConsoleMsg("ReaperAI bridge error: " .. tostring(err) .. "\n") end
    end
    if now - last_beat >= HEARTBEAT_INTERVAL then
      last_beat = now
      pcall(M.write_heartbeat, instance)
    end
    reaper.defer(loop)
  end

  reaper.atexit(function()
    if reaper.GetExtState("ReaperAI", "instance") == instance then
      os.remove(dirs.heartbeat)
      reaper.DeleteExtState("ReaperAI", "instance", false)
    end
  end)
  reaper.ShowConsoleMsg("ReaperAI bridge " .. BRIDGE_VERSION .. " started: " .. dirs.bridge .. "\n")
  loop()
end

if REAPER_AI_NO_RUN then
  return M
end
M.run()
