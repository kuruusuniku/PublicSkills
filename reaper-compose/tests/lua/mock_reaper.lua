-- REAPER API のテスト用モック。
-- 関数の引数と戻り値は reaper-sdk の reaper_plugin_functions.h の Lua 変換規則
-- (戻り値 → Out 引数の順で複数返す) に合わせている。型が違えば error にする。
-- 未実装の関数を呼ぶと error になるので、ブリッジが使う関数の漏れも検出できる。

local Mock = {}

local function check(cond, msg)
  if not cond then error("mock: " .. msg, 3) end
end
local function is_int(v) return math.type(v) == "integer" or (type(v) == "number" and v == math.floor(v)) end
local function check_proj(p) check(p == 0 or p == nil, "proj must be 0/nil, got " .. tostring(p)) end

function Mock.new(opts)
  opts = opts or {}
  local R = {}
  local T = {} -- テストからプロジェクトを組み立てるためのヘルパー
  local S = {
    bpm = opts.bpm or 120,
    -- 拍子の区間: { start_bar (1 始まり), num, denom }
    meter = opts.meter or { { 1, 4, 4 } },
    tracks = {},
    markers = {},
    ext = {},
    cursor = 0, playing = false, loop = { 0, 0 }, repeat_on = 0,
    undo_depth = 0, undo_log = {}, ui_refresh = 0,
    console = {}, deferred = nil, atexit = nil,
    clock = 0,
    installed_fx = opts.installed_fx or {
      { "AUi: DLSMusicDevice (Apple)", "DLSMusicDevice" },
      { "VST: ReaSynth (Cockos)", "reasynth" },
      { "VST3i: HALion Sonic (Steinberg Media Technologies)", "HALion Sonic" },
      { "JS: MIDI/midi_transpose", "midi_transpose" },
    },
    guid_counter = 0,
  }
  T.state = S

  local function new_guid()
    S.guid_counter = S.guid_counter + 1
    return string.format("{00000000-0000-0000-0000-%012d}", S.guid_counter)
  end

  -- 時間マップ ------------------------------------------------------------
  local spq = 60 / S.bpm -- 秒/QN

  local function bar_len_qn(num, denom) return num * 4 / denom end

  -- measure (0 始まり) → qn_start, num, denom
  local function measure_start(measure)
    local qn = 0
    for i, seg in ipairs(S.meter) do
      local start_m = seg[1] - 1
      local next_m = S.meter[i + 1] and (S.meter[i + 1][1] - 1) or math.huge
      if measure < next_m then
        return qn + (measure - start_m) * bar_len_qn(seg[2], seg[3]), seg[2], seg[3]
      end
      qn = qn + (next_m - start_m) * bar_len_qn(seg[2], seg[3])
    end
  end

  local function qn_to_measure(qn)
    local m = 0
    while true do
      local s, num, denom = measure_start(m)
      local e = s + bar_len_qn(num, denom)
      if qn < e - 1e-12 then return m, s, num, denom end
      m = m + 1
    end
  end

  function R.TimeMap2_QNToTime(proj, qn)
    check_proj(proj); check(type(qn) == "number", "QNToTime qn")
    return qn * spq
  end
  function R.TimeMap2_timeToQN(proj, t)
    check_proj(proj); check(type(t) == "number", "timeToQN t")
    return t / spq
  end
  -- double TimeMap2_timeToBeats(proj, tpos, int* measuresOut, int* cmlOut, double* fullbeatsOut, int* cdenomOut)
  function R.TimeMap2_timeToBeats(proj, tpos)
    check_proj(proj); check(type(tpos) == "number", "timeToBeats tpos")
    local qn = tpos / spq
    local m, s, num, denom = qn_to_measure(qn)
    local beats = (qn - s) * denom / 4
    local full = 0
    for i = 0, m - 1 do local _, n2 = measure_start(i); full = full + n2 end
    return beats, m, num, full + beats, denom
  end
  -- double TimeMap_GetMeasureInfo(proj, int measure, double* qn_startOut, double* qn_endOut, int* numOut, int* denomOut, double* tempoOut)
  function R.TimeMap_GetMeasureInfo(proj, measure)
    check_proj(proj); check(is_int(measure), "GetMeasureInfo measure must be int")
    local s, num, denom = measure_start(math.max(0, measure))
    return s * spq, s, s + bar_len_qn(num, denom), num, denom, S.bpm
  end
  -- void TimeMap_GetTimeSigAtTime(proj, time, int* numOut, int* denomOut, double* tempoOut)
  function R.TimeMap_GetTimeSigAtTime(proj, t)
    check_proj(proj); check(type(t) == "number", "GetTimeSigAtTime t")
    local _, _, num, denom = qn_to_measure(t / spq)
    return num, denom, S.bpm
  end
  function R.CountTempoTimeSigMarkers(proj) check_proj(proj); return #S.meter end
  -- bool GetTempoTimeSigMarker(proj, idx, double* timeposOut, int* measureposOut, double* beatposOut, double* bpmOut, int* numOut, int* denomOut, bool* linearOut)
  function R.GetTempoTimeSigMarker(proj, idx)
    check_proj(proj); check(is_int(idx), "GetTempoTimeSigMarker idx")
    local seg = S.meter[idx + 1]
    if not seg then return false, 0, 0, 0, 0, 0, 0, false end
    local qn = measure_start(seg[1] - 1)
    return true, qn * spq, seg[1] - 1, 0, S.bpm, seg[2], seg[3], false
  end

  -- トラック -------------------------------------------------------------
  local function new_track(name)
    return { __kind = "track", name = name or "", guid = new_guid(), ext = {}, items = {}, fx = {},
             mute = 0, solo = 0, vol = 1 }
  end
  function T.add_track(name)
    local tr = new_track(name)
    S.tracks[#S.tracks + 1] = tr
    return tr
  end
  local function check_track(tr) check(type(tr) == "table" and tr.__kind == "track", "expected MediaTrack") end

  function R.CountTracks(proj) check_proj(proj); return #S.tracks end
  function R.GetTrack(proj, idx)
    check_proj(proj); check(is_int(idx), "GetTrack idx")
    return S.tracks[idx + 1]
  end
  function R.InsertTrackAtIndex(idx, wantDefaults)
    check(is_int(idx), "InsertTrackAtIndex idx"); check(type(wantDefaults) == "boolean", "InsertTrackAtIndex wantDefaults")
    idx = math.max(0, math.min(idx, #S.tracks))
    table.insert(S.tracks, idx + 1, new_track(""))
  end
  function R.DeleteTrack(tr)
    check_track(tr)
    for i, t in ipairs(S.tracks) do if t == tr then table.remove(S.tracks, i) return end end
  end
  -- bool GetSetMediaTrackInfo_String(tr, parmname, stringNeedBig, setNewValue)
  function R.GetSetMediaTrackInfo_String(tr, parm, val, set)
    check_track(tr); check(type(parm) == "string", "parm"); check(type(val) == "string", "stringNeedBig must be string")
    check(type(set) == "boolean", "setNewValue must be boolean")
    if parm == "P_NAME" then
      if set then tr.name = val end
      return true, tr.name
    elseif parm == "GUID" then
      return true, tr.guid
    elseif parm:match("^P_EXT:") then
      if set then tr.ext[parm] = val end
      return tr.ext[parm] ~= nil, tr.ext[parm] or ""
    end
    error("mock: unsupported track string parm " .. parm)
  end
  function R.GetMediaTrackInfo_Value(tr, parm)
    check_track(tr)
    if parm == "IP_TRACKNUMBER" then
      for i, t in ipairs(S.tracks) do if t == tr then return i + 0.0 end end
      return 0.0
    elseif parm == "B_MUTE" then return tr.mute + 0.0
    elseif parm == "I_SOLO" then return tr.solo + 0.0
    elseif parm == "D_VOL" then return tr.vol end
    error("mock: unsupported track value parm " .. parm)
  end
  function R.SetMediaTrackInfo_Value(tr, parm, v)
    check_track(tr); check(type(v) == "number", "SetMediaTrackInfo_Value value")
    if parm == "B_MUTE" then tr.mute = math.floor(v)
    elseif parm == "I_SOLO" then tr.solo = math.floor(v)
    elseif parm == "D_VOL" then tr.vol = v
    else error("mock: unsupported track set parm " .. parm) end
    return true
  end

  -- FX -------------------------------------------------------------------
  function R.TrackFX_GetCount(tr) check_track(tr); return #tr.fx end
  -- bool TrackFX_GetFXName(track, fx, char* bufOut, int bufOut_sz)
  function R.TrackFX_GetFXName(tr, idx, buf)
    check_track(tr); check(is_int(idx), "TrackFX_GetFXName idx")
    check(buf == nil or type(buf) == "string", "TrackFX_GetFXName buf")
    local fx = tr.fx[idx + 1]
    return fx ~= nil, fx or ""
  end
  -- int TrackFX_AddByName(track, fxname, bool recFX, int instantiate)
  function R.TrackFX_AddByName(tr, name, recFX, inst)
    check_track(tr); check(type(name) == "string", "fxname"); check(type(recFX) == "boolean", "recFX bool")
    check(is_int(inst), "instantiate int")
    for _, fx in ipairs(S.installed_fx) do
      local full, ident = fx[1], fx[2]
      local bare = full:gsub("^%w+:%s*", "")
      if name == full or name == bare or name == ident then
        tr.fx[#tr.fx + 1] = full
        return #tr.fx - 1
      end
    end
    return -1
  end
  function R.TrackFX_Show(tr, idx, flag) check_track(tr); check(is_int(idx) and is_int(flag), "TrackFX_Show") end
  -- bool EnumInstalledFX(int index, const char** nameOut, const char** identOut)
  function R.EnumInstalledFX(i)
    check(is_int(i), "EnumInstalledFX index")
    local fx = S.installed_fx[i + 1]
    if not fx then return false, "", "" end
    return true, fx[1], fx[2]
  end

  -- アイテムとテイク -------------------------------------------------------
  local PPQ = 960
  local function check_item(it) check(type(it) == "table" and it.__kind == "item", "expected MediaItem") end
  local function check_take(tk) check(type(tk) == "table" and tk.__kind == "take", "expected MediaItem_Take") end

  local function new_item(tr, start_qn, end_qn)
    local item = { __kind = "item", track = tr, guid = new_guid(), pos = start_qn * spq, len = (end_qn - start_qn) * spq,
                   mute = 0, selected = false }
    -- テイクのノート/CC は「テイク先頭からの PPQ」で持つ (REAPER と同じ)
    item.take = { __kind = "take", item = item, name = "", notes = {}, ccs = {}, midi = true, ppq0_qn = start_qn }
    tr.items[#tr.items + 1] = item
    return item
  end
  function T.add_midi_item(tr, start_qn, end_qn, notes, ccs)
    local item = new_item(tr, start_qn, end_qn)
    for _, n in ipairs(notes or {}) do
      local s, len, pitch, vel, ch = n[1], n[2], n[3], n[4] or 96, n[5] or 1
      table.insert(item.take.notes, { sel = false, muted = false, s = (s - start_qn) * PPQ, e = (s + len - start_qn) * PPQ,
                                      chan = ch - 1, pitch = pitch, vel = vel })
    end
    for _, c in ipairs(ccs or {}) do
      local s, num, val, ch = c[1], c[2], c[3], c[4] or 1
      table.insert(item.take.ccs, { sel = false, muted = false, ppq = (s - start_qn) * PPQ, chanmsg = 0xB0, chan = ch - 1, msg2 = num, msg3 = val })
    end
    return item
  end
  function T.add_audio_item(tr, start_qn, end_qn)
    local item = new_item(tr, start_qn, end_qn)
    item.take.midi = false
    return item
  end

  local function all_items()
    local out = {}
    for _, tr in ipairs(S.tracks) do for _, it in ipairs(tr.items) do out[#out + 1] = it end end
    return out
  end

  function R.CountMediaItems(proj) check_proj(proj); return #all_items() end
  function R.GetMediaItem(proj, i) check_proj(proj); check(is_int(i), "GetMediaItem idx"); return all_items()[i + 1] end
  function R.CountTrackMediaItems(tr) check_track(tr); return #tr.items end
  function R.GetTrackMediaItem(tr, i) check_track(tr); check(is_int(i), "GetTrackMediaItem idx"); return tr.items[i + 1] end
  function R.GetMediaItem_Track(it) check_item(it); return it.track end
  function R.CountSelectedMediaItems(proj)
    check_proj(proj)
    local n = 0
    for _, it in ipairs(all_items()) do if it.selected then n = n + 1 end end
    return n
  end
  function R.GetSelectedMediaItem(proj, i)
    check_proj(proj); check(is_int(i), "GetSelectedMediaItem idx")
    local n = 0
    for _, it in ipairs(all_items()) do
      if it.selected then
        if n == i then return it end
        n = n + 1
      end
    end
    return nil
  end
  function R.GetMediaItemInfo_Value(it, parm)
    check_item(it)
    if parm == "D_POSITION" then return it.pos
    elseif parm == "D_LENGTH" then return it.len
    elseif parm == "B_MUTE" then return it.mute + 0.0 end
    error("mock: unsupported item parm " .. parm)
  end
  function R.GetSetMediaItemInfo_String(it, parm, val, set)
    check_item(it); check(type(val) == "string", "stringNeedBig"); check(type(set) == "boolean", "setNewValue")
    if parm == "GUID" then return true, it.guid end
    error("mock: unsupported item string parm " .. parm)
  end
  function R.GetActiveTake(it) check_item(it); return it.take end
  function R.TakeIsMIDI(tk) check_take(tk); return tk.midi end
  function R.GetSetMediaItemTakeInfo_String(tk, parm, val, set)
    check_take(tk); check(type(val) == "string", "stringNeedBig"); check(type(set) == "boolean", "setNewValue")
    if parm == "P_NAME" then
      if set then tk.name = val end
      return true, tk.name
    end
    error("mock: unsupported take string parm " .. parm)
  end
  -- MediaItem* CreateNewMIDIItemInProj(track, starttime, endtime, const bool* qnInOptional)
  function R.CreateNewMIDIItemInProj(tr, s, e, qn)
    check_track(tr); check(type(s) == "number" and type(e) == "number", "CreateNewMIDIItemInProj times")
    check(qn == nil or type(qn) == "boolean", "qnIn must be boolean")
    if not qn then s, e = s / spq, e / spq end
    return new_item(tr, s, e)
  end
  -- bool MIDI_SetItemExtents(item, startQN, endQN)
  function R.MIDI_SetItemExtents(it, sqn, eqn)
    check_item(it); check(type(sqn) == "number" and type(eqn) == "number", "MIDI_SetItemExtents")
    -- ノートのプロジェクト位置は変えない
    local shift = (it.take.ppq0_qn - sqn) * PPQ
    for _, n in ipairs(it.take.notes) do n.s, n.e = n.s + shift, n.e + shift end
    for _, c in ipairs(it.take.ccs) do c.ppq = c.ppq + shift end
    it.take.ppq0_qn = sqn
    it.pos, it.len = sqn * spq, (eqn - sqn) * spq
    return true
  end

  function R.MIDI_GetPPQPosFromProjQN(tk, qn)
    check_take(tk); check(type(qn) == "number", "MIDI_GetPPQPosFromProjQN qn")
    return (qn - tk.ppq0_qn) * PPQ
  end
  function R.MIDI_GetProjQNFromPPQPos(tk, ppq)
    check_take(tk); check(type(ppq) == "number", "MIDI_GetProjQNFromPPQPos ppq")
    return tk.ppq0_qn + ppq / PPQ
  end
  -- int MIDI_CountEvts(take, int* notecntOut, int* ccevtcntOut, int* textsyxevtcntOut)
  function R.MIDI_CountEvts(tk)
    check_take(tk)
    return #tk.notes + #tk.ccs, #tk.notes, #tk.ccs, 0
  end
  -- bool MIDI_GetNote(take, noteidx, bool* selectedOut, bool* mutedOut, double* startppqposOut, double* endppqposOut, int* chanOut, int* pitchOut, int* velOut)
  function R.MIDI_GetNote(tk, i)
    check_take(tk); check(is_int(i), "MIDI_GetNote idx")
    local n = tk.notes[i + 1]
    if not n then return false, false, false, 0, 0, 0, 0, 0 end
    return true, n.sel, n.muted, n.s, n.e, n.chan, n.pitch, n.vel
  end
  -- bool MIDI_InsertNote(take, bool selected, bool muted, double startppqpos, double endppqpos, int chan, int pitch, int vel, const bool* noSortInOptional)
  function R.MIDI_InsertNote(tk, sel, muted, s, e, chan, pitch, vel, noSort)
    check_take(tk)
    check(type(sel) == "boolean" and type(muted) == "boolean", "MIDI_InsertNote selected/muted must be boolean")
    check(type(s) == "number" and type(e) == "number" and e > s, "MIDI_InsertNote ppq")
    check(math.type(chan) == "integer" and chan >= 0 and chan <= 15, "MIDI_InsertNote chan int 0-15")
    check(math.type(pitch) == "integer" and pitch >= 0 and pitch <= 127, "MIDI_InsertNote pitch int")
    check(math.type(vel) == "integer" and vel >= 1 and vel <= 127, "MIDI_InsertNote vel int")
    check(noSort == nil or type(noSort) == "boolean", "MIDI_InsertNote noSort")
    tk.notes[#tk.notes + 1] = { sel = sel, muted = muted, s = s, e = e, chan = chan, pitch = pitch, vel = vel }
    if not noSort then R.MIDI_Sort(tk) end
    return true
  end
  function R.MIDI_DeleteNote(tk, i)
    check_take(tk); check(is_int(i), "MIDI_DeleteNote idx")
    if not tk.notes[i + 1] then return false end
    table.remove(tk.notes, i + 1)
    return true
  end
  -- bool MIDI_GetCC(take, ccidx, bool* selectedOut, bool* mutedOut, double* ppqposOut, int* chanmsgOut, int* chanOut, int* msg2Out, int* msg3Out)
  function R.MIDI_GetCC(tk, i)
    check_take(tk); check(is_int(i), "MIDI_GetCC idx")
    local c = tk.ccs[i + 1]
    if not c then return false, false, false, 0, 0, 0, 0, 0 end
    return true, c.sel, c.muted, c.ppq, c.chanmsg, c.chan, c.msg2, c.msg3
  end
  -- bool MIDI_InsertCC(take, bool selected, bool muted, double ppqpos, int chanmsg, int chan, int msg2, int msg3)
  function R.MIDI_InsertCC(tk, sel, muted, ppq, chanmsg, chan, msg2, msg3)
    check_take(tk)
    check(type(sel) == "boolean" and type(muted) == "boolean", "MIDI_InsertCC selected/muted must be boolean")
    check(type(ppq) == "number", "MIDI_InsertCC ppq")
    for _, v in ipairs({ chanmsg, chan, msg2, msg3 }) do check(math.type(v) == "integer", "MIDI_InsertCC ints") end
    check(msg2 >= 0 and msg2 <= 127 and msg3 >= 0 and msg3 <= 127, "MIDI_InsertCC data range")
    tk.ccs[#tk.ccs + 1] = { sel = sel, muted = muted, ppq = ppq, chanmsg = chanmsg, chan = chan, msg2 = msg2, msg3 = msg3 }
    return true
  end
  function R.MIDI_DeleteCC(tk, i)
    check_take(tk); check(is_int(i), "MIDI_DeleteCC idx")
    if not tk.ccs[i + 1] then return false end
    table.remove(tk.ccs, i + 1)
    return true
  end
  function R.MIDI_Sort(tk)
    check_take(tk)
    table.sort(tk.notes, function(a, b) if a.s ~= b.s then return a.s < b.s end return a.pitch < b.pitch end)
    table.sort(tk.ccs, function(a, b) return a.ppq < b.ppq end)
  end

  -- マーカー -------------------------------------------------------------
  -- int CountProjectMarkers(proj, int* num_markersOut, int* num_regionsOut)
  function R.CountProjectMarkers(proj)
    check_proj(proj)
    local m, r = 0, 0
    for _, mk in ipairs(S.markers) do if mk.isrgn then r = r + 1 else m = m + 1 end end
    return m + r, m, r
  end
  -- int EnumProjectMarkers3(proj, idx, bool* isrgnOut, double* posOut, double* rgnendOut, const char** nameOut, int* markrgnindexnumberOut, int* colorOut)
  function R.EnumProjectMarkers3(proj, i)
    check_proj(proj); check(is_int(i), "EnumProjectMarkers3 idx")
    local mk = S.markers[i + 1]
    if not mk then return 0, false, 0, 0, "", 0, 0 end
    return i + 1, mk.isrgn, mk.pos, mk.rgnend, mk.name, mk.idx, mk.color
  end
  -- int AddProjectMarker2(proj, bool isrgn, double pos, double rgnend, const char* name, int wantidx, int color)
  function R.AddProjectMarker2(proj, isrgn, pos, rgnend, name, wantidx, color)
    check_proj(proj); check(type(isrgn) == "boolean", "AddProjectMarker2 isrgn")
    check(type(pos) == "number" and type(rgnend) == "number", "AddProjectMarker2 pos")
    check(type(name) == "string", "AddProjectMarker2 name"); check(is_int(wantidx) and is_int(color), "AddProjectMarker2 ints")
    local idx = #S.markers + 1
    S.markers[#S.markers + 1] = { isrgn = isrgn, pos = pos, rgnend = rgnend, name = name, idx = idx, color = color }
    table.sort(S.markers, function(a, b) return a.pos < b.pos end)
    return idx
  end

  -- トランスポートなど -----------------------------------------------------
  function R.GetCursorPosition() return S.cursor end
  function R.SetEditCurPos2(proj, t, moveview, seekplay)
    check_proj(proj); check(type(t) == "number", "SetEditCurPos2 time")
    check(type(moveview) == "boolean" and type(seekplay) == "boolean", "SetEditCurPos2 flags")
    S.cursor = t
  end
  function R.GetPlayState() return S.playing and 1 or 0 end
  function R.OnPlayButton() S.playing = true end
  function R.OnStopButton() S.playing = false end
  -- void GetSet_LoopTimeRange2(proj, bool isSet, bool isLoop, double* startOut, double* endOut, bool allowautoseek)
  function R.GetSet_LoopTimeRange2(proj, isSet, isLoop, s, e, autoseek)
    check_proj(proj); check(type(isSet) == "boolean" and type(isLoop) == "boolean", "LoopTimeRange flags")
    check(type(s) == "number" and type(e) == "number", "LoopTimeRange start/end"); check(type(autoseek) == "boolean", "autoseek")
    if isSet then S.loop = { s, e } end
    return S.loop[1], S.loop[2]
  end
  function R.GetSetRepeat(v) check(is_int(v), "GetSetRepeat"); if v >= 0 then S.repeat_on = v end return S.repeat_on end
  function R.GetProjectLength(proj)
    check_proj(proj)
    local len = 0
    for _, it in ipairs(all_items()) do len = math.max(len, it.pos + it.len) end
    return len
  end
  function R.GetProjectName(proj, buf)
    check_proj(proj); check(buf == nil or type(buf) == "string", "GetProjectName buf")
    return opts.project_name or "Test Song.rpp"
  end
  function R.GetAppVersion() return "7.27/macOS-arm64" end

  function R.Undo_BeginBlock2(proj) check_proj(proj); S.undo_depth = S.undo_depth + 1 end
  function R.Undo_EndBlock2(proj, desc, flags)
    check_proj(proj); check(type(desc) == "string" and is_int(flags), "Undo_EndBlock2 args")
    check(S.undo_depth > 0, "Undo_EndBlock2 without Begin")
    S.undo_depth = S.undo_depth - 1
    S.undo_log[#S.undo_log + 1] = desc
  end
  function R.PreventUIRefresh(n) check(is_int(n), "PreventUIRefresh"); S.ui_refresh = S.ui_refresh + n end
  function R.UpdateArrange() end
  function R.TrackList_AdjustWindows(b) check(type(b) == "boolean", "TrackList_AdjustWindows") end

  function R.SetExtState(sec, key, val, persist)
    check(type(sec) == "string" and type(key) == "string" and type(val) == "string" and type(persist) == "boolean", "SetExtState")
    S.ext[sec .. "/" .. key] = val
  end
  function R.GetExtState(sec, key) return S.ext[sec .. "/" .. key] or "" end
  function R.DeleteExtState(sec, key, persist) S.ext[sec .. "/" .. key] = nil end
  function R.ShowConsoleMsg(s) check(type(s) == "string", "ShowConsoleMsg"); S.console[#S.console + 1] = s end
  function R.defer(fn) check(type(fn) == "function", "defer"); S.deferred = fn end
  function R.atexit(fn) check(type(fn) == "function", "atexit"); S.atexit = fn end
  function R.time_precise() S.clock = S.clock + 0.05; return S.clock end

  -- ファイルシステム -------------------------------------------------------
  function R.RecursiveCreateDirectory(path, ignored)
    check(type(path) == "string" and is_int(ignored), "RecursiveCreateDirectory")
    os.execute("mkdir -p '" .. path:gsub("'", "'\\''") .. "'")
    return 1
  end
  local dir_cache = {}
  function R.EnumerateFiles(path, idx)
    check(type(path) == "string" and is_int(idx), "EnumerateFiles")
    if idx == -1 or not dir_cache[path] then
      local list = {}
      local p = io.popen("ls -1 '" .. path:gsub("'", "'\\''") .. "' 2>/dev/null")
      for line in p:lines() do list[#list + 1] = line end
      p:close()
      dir_cache[path] = list
      if idx == -1 then return nil end
    end
    return dir_cache[path][idx + 1]
  end

  setmetatable(R, { __index = function(_, k)
    error("mock: reaper." .. tostring(k) .. " is not implemented", 2)
  end })
  return R, T
end

return Mock
