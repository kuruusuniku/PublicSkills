-- ai_bridge.lua のテスト。モックの REAPER の上で動かす。
-- 使い方: lua5.4 tests/lua/test_bridge.lua <skill_dir>

local SKILL_DIR = arg[1] or "."
package.path = SKILL_DIR .. "/tests/lua/?.lua;" .. package.path
local Mock = require("mock_reaper")

local passed, failed = 0, 0
local current

local function test(name, fn)
  current = name
  local ok, err = xpcall(fn, debug.traceback)
  if ok then
    passed = passed + 1
  else
    failed = failed + 1
    io.stderr:write("FAIL: " .. name .. "\n  " .. tostring(err):gsub("\n", "\n  ") .. "\n")
  end
end

local function eq(a, b, msg)
  if a ~= b then error((msg or "") .. " expected " .. tostring(b) .. ", got " .. tostring(a), 2) end
end
local function near(a, b, msg)
  if type(a) ~= "number" or math.abs(a - b) > 1e-6 then error((msg or "") .. " expected ~" .. tostring(b) .. ", got " .. tostring(a), 2) end
end
local function truthy(v, msg) if not v then error(msg or "expected truthy", 2) end end
local function contains(s, sub, msg)
  if type(s) ~= "string" or not s:find(sub, 1, true) then error((msg or "") .. " expected to contain '" .. sub .. "' in: " .. tostring(s), 2) end
end

local function tmpdir()
  local p = io.popen("mktemp -d")
  local d = p:read("l")
  p:close()
  return d
end

-- 4/4 (1-4小節) → 3/4 (5-6小節) → 6/8 (7小節〜)
local METER = { { 1, 4, 4 }, { 5, 3, 4 }, { 7, 6, 8 } }

local function load_bridge(opts)
  local R, T = Mock.new(opts)
  _G.reaper = R
  _G.REAPER_AI_NO_RUN = true
  _G.REAPER_AI_DIR_OVERRIDE = (opts and opts.base) or tmpdir()
  local M = dofile(SKILL_DIR .. "/reaper/ai_bridge.lua")
  return M, R, T
end

local function call(M, op, args)
  return M.handle({ op = op, args = args or {} })
end

---------------------------------------------------------------------------
-- JSON
---------------------------------------------------------------------------

test("json roundtrip", function()
  local M = load_bridge()
  local j = M.json
  local v = { a = 1, b = { 1, 2.5, -3e-3, "x" }, c = "日本語 \"quote\" \\ \n\t", d = true, e = false }
  local back = j.decode(j.encode(v))
  eq(back.a, 1); eq(back.b[2], 2.5); near(back.b[3], -0.003); eq(back.b[4], "x")
  eq(back.c, v.c); eq(back.d, true); eq(back.e, false)
  eq(math.type(back.a), "integer")
end)

test("json encodes empty table as array and object marker as object", function()
  local M = load_bridge()
  eq(M.json.encode({}), "[]")
  eq(M.json.encode(M.json.object()), "{}")
  eq(M.json.encode({ x = M.json.array() }), '{"x":[]}')
end)

test("json escapes control chars and NaN", function()
  local M = load_bridge()
  eq(M.json.encode("a\1b"), '"a\\u0001b"')
  eq(M.json.encode({ 0 / 0 }), "[null]")
  eq(M.json.encode(1.5), "1.5")
  eq(M.json.encode(3), "3")
end)

test("json decodes unicode escapes including surrogate pairs", function()
  local M = load_bridge()
  eq(M.json.decode('"\\u3042\\ud83c\\udfb9"'), "あ🎹")
  eq(M.json.decode('"a\\/b"'), "a/b")
end)

test("json decode errors", function()
  local M = load_bridge()
  truthy(not pcall(M.json.decode, '{"a":1} x'), "trailing")
  truthy(not pcall(M.json.decode, '"abc'), "unterminated")
  truthy(not pcall(M.json.decode, '{a:1}'), "unquoted key")
  local ok, v = pcall(M.json.decode, ' { "n" : [ ] , "m" : { } } ')
  truthy(ok); eq(#v.n, 0)
end)

---------------------------------------------------------------------------
-- 時間変換
---------------------------------------------------------------------------

test("selftest passes with meter changes", function()
  local M = load_bridge({ meter = METER })
  local r = call(M, "selftest")
  truthy(r.ok, r.error)
  truthy(r.result.ok, "selftest result")
end)

test("bar/beat conversion across meter changes", function()
  local M = load_bridge({ meter = METER })
  local h = M.helpers
  near(h.barbeat_to_qn(1, 1), 0)
  near(h.barbeat_to_qn(5, 1), 16)
  near(h.barbeat_to_qn(6, 1), 19)
  near(h.barbeat_to_qn(7, 1), 22)
  near(h.barbeat_to_qn(7, 2), 22.5) -- 6/8 の拍は八分音符
  local bar, beat, num, denom = h.qn_to_barbeat(22.5)
  eq(bar, 7); near(beat, 2); eq(num, 6); eq(denom, 8)
  bar, beat = h.qn_to_barbeat(18.9999999999)
  eq(bar, 6, "rounding at bar end"); near(beat, 1)
end)

---------------------------------------------------------------------------
-- プロジェクトの組み立て
---------------------------------------------------------------------------

local function piano_project(opts)
  local M, R, T = load_bridge(opts or { meter = { { 1, 4, 4 } } })
  local piano = T.add_track("Piano")
  -- C E G (bar1), A C E (bar2) + pedal
  local item = T.add_midi_item(piano, 0, 8, {
    { 0, 4, 48, 70 }, { 0, 4, 52, 72 }, { 0, 4, 55, 74 },
    { 4, 2, 45, 60 }, { 4, 2, 48, 61 }, { 4, 2, 52, 62 }, { 6.5, 0.5, 76, 90 },
  }, { { 0, 64, 127 }, { 3.9, 64, 0 } })
  local audio = T.add_track("Vocal")
  T.add_audio_item(audio, 0, 8)
  return M, R, T, piano, item
end

test("ping and project", function()
  local M = piano_project()
  local r = call(M, "ping")
  truthy(r.ok, r.error); eq(r.result.bridge_version, M.version)
  r = call(M, "project")
  truthy(r.ok, r.error)
  local p = r.result
  eq(#p.tracks, 2); eq(p.tracks[1].name, "Piano"); eq(p.tracks[1].midi_items, 1); eq(p.tracks[2].midi_items, 0)
  eq(p.tracks[1].first_bar, 1); eq(p.tracks[1].last_bar, 2)
  eq(p.tempo, 120); eq(p.timesig[1], 4); eq(p.length_bars, 2)
end)

test("read_midi by track gives bar/beat, names, 1-based channels and pedal", function()
  local M = piano_project()
  local r = call(M, "read_midi", { track = "Piano" })
  truthy(r.ok, r.error)
  local it = r.result.items[1]
  eq(it.track, "Piano"); eq(#it.notes, 7); eq(it.start_bar, 1); eq(it.end_bar, 2)
  eq(it.notes[1].name, "C3"); eq(it.notes[1].ch, 1); eq(it.notes[1].bar, 1); near(it.notes[1].beat, 1)
  local last = it.notes[7]
  eq(last.name, "E5"); eq(last.bar, 2); near(last.beat, 3.5); near(last.len, 0.5)
  eq(#it.cc, 2); eq(it.cc[1].type, "cc"); eq(it.cc[1].cc, 64); eq(it.cc[1].val, 127)
  eq(#it.bars, 2); near(it.bars[2].start, 4); near(it.bars[2]["end"], 8)
  -- JSON にできること (Python に渡る形)
  local s = M.json.encode(r)
  contains(s, '"name":"C3"')
end)

test("read_midi track matching is case-insensitive and by number", function()
  local M = piano_project()
  truthy(call(M, "read_midi", { track = "piano" }).ok)
  truthy(call(M, "read_midi", { track = 1 }).ok)
  local r = call(M, "read_midi", { track = "Nope" })
  eq(r.ok, false); contains(r.error, "トラックが見つかりません")
end)

test("read_midi bar range filters notes and bars", function()
  local M = piano_project()
  local r = call(M, "read_midi", { track = "Piano", start_bar = 2, end_bar = 2 })
  truthy(r.ok, r.error)
  local it = r.result.items[1]
  eq(#it.notes, 4); eq(#it.bars, 1); eq(it.bars[1].bar, 2)
end)

test("read_midi without selection explains what to do", function()
  local M = piano_project()
  local r = call(M, "read_midi")
  eq(r.ok, false); contains(r.error, "選択")
end)

test("read_midi uses selected items", function()
  local M, _, _, _, item = piano_project()
  item.selected = true
  local r = call(M, "read_midi")
  truthy(r.ok, r.error); eq(#r.result.items, 1)
end)

test("read_midi on audio-only track fails clearly", function()
  local M = piano_project()
  local r = call(M, "read_midi", { track = "Vocal" })
  eq(r.ok, false); contains(r.error, "MIDI アイテムがありません")
end)

---------------------------------------------------------------------------
-- 書き込み
---------------------------------------------------------------------------

test("write_midi creates a tagged track after the reference with an undo block", function()
  local M, R, T = piano_project()
  local r = call(M, "write_midi", {
    track = "Bass v1 (AI)", after = "Piano", name = "bass idea", program = 33,
    instrument = "AUi: DLSMusicDevice (Apple)",
    notes = {
      { bar = 1, beat = 1, len = 1.5, pitch = 36, vel = 90 },
      { bar = 1, beat = 2.5, len = 0.5, pitch = "G1" },
      { start = 4, len = 4, pitch = "A1", vel = 80, ch = 2 },
    },
  })
  truthy(r.ok, r.error)
  local res = r.result
  eq(res.track, "Bass v1 (AI)"); eq(res.track_number, 2); eq(res.created_track, true)
  eq(res.notes, 3); eq(res.start_bar, 1); eq(res.end_bar, 2)
  eq(res.instrument, "AUi: DLSMusicDevice (Apple)")
  local S = T.state
  eq(S.tracks[2].name, "Bass v1 (AI)"); eq(S.tracks[3].name, "Vocal")
  eq(S.tracks[2].ext["P_EXT:reaper_ai"], "1")
  eq(S.undo_depth, 0); eq(S.ui_refresh, 0)
  contains(S.undo_log[#S.undo_log], "AI: write MIDI Bass v1 (AI)")
  local take = S.tracks[2].items[1].take
  eq(take.name, "bass idea")
  eq(#take.notes, 3)
  -- 位置は PPQ (960/QN、アイテム先頭基準)
  near(take.notes[2].s, 1.5 * 960); eq(take.notes[2].pitch, 31); eq(take.notes[2].vel, 96)
  eq(take.notes[3].chan, 1)
  eq(take.ccs[1].chanmsg, 0xC0); eq(take.ccs[1].msg2, 33); eq(take.ccs[1].chan, 0)
  -- 読み戻し
  local back = call(M, "read_midi", { track = "Bass v1 (AI)" }).result.items[1]
  eq(back.notes[1].name, "C2"); near(back.notes[2].beat, 2.5); eq(back.notes[3].ch, 2)
  eq(back.cc[1].type, "pc"); eq(back.cc[1].val, 33)
end)

test("write_midi works in odd meters and pads the item to whole bars", function()
  local M, _, T = load_bridge({ meter = METER })
  local r = call(M, "write_midi", { track = "Perc (AI)", notes = {
    { bar = 7, beat = 2, len = 0.5, pitch = 36, ch = 10 },
    { bar = 5, beat = 3, len = 1, pitch = 38, ch = 10 },
  } })
  truthy(r.ok, r.error)
  eq(r.result.start_bar, 5); eq(r.result.end_bar, 7)
  local item = T.state.tracks[1].items[1]
  near(item.pos, 16 * 0.5); near(item.len, (25 - 16) * 0.5)
  local back = call(M, "read_midi", { track = "Perc (AI)" }).result.items[1]
  eq(back.notes[1].bar, 5); near(back.notes[1].beat, 3)
  eq(back.notes[2].bar, 7); near(back.notes[2].beat, 2)
end)

test("write_midi validates everything before touching the project", function()
  local M, _, T = piano_project()
  local r = call(M, "write_midi", { track = "X (AI)", notes = {
    { bar = 1, len = 1, pitch = "H2" },
    { bar = 1, pitch = 60 },
    { bar = 1, len = 1, pitch = 60, vel = 0 },
    { bar = 1, len = 1, pitch = 60, ch = 17 },
    { len = 1, pitch = 60 },
    { bar = 0, len = 1, pitch = 60 },
  } })
  eq(r.ok, false)
  contains(r.error, "notes[1]"); contains(r.error, "notes[2]"); contains(r.error, "vel")
  contains(r.error, "ch は 1-16"); contains(r.error, "notes[5]"); contains(r.error, "bar は 1 以上")
  eq(#T.state.tracks, 2, "no track created")
  eq(T.state.undo_depth, 0); eq(T.state.ui_refresh, 0)
end)

test("write_midi rejects empty input and events outside explicit bars", function()
  local M = piano_project()
  local r = call(M, "write_midi", { track = "X (AI)", notes = {} })
  eq(r.ok, false); contains(r.error, "空")
  r = call(M, "write_midi", { track = "X (AI)", end_bar = 1, notes = { { bar = 2, len = 1, pitch = 60 } } })
  eq(r.ok, false); contains(r.error, "end_bar")
  r = call(M, "write_midi", { track = "X (AI)", start_bar = 2, notes = { { bar = 1, len = 1, pitch = 60 } } })
  eq(r.ok, false); contains(r.error, "start_bar")
end)

test("write_midi with create=false refuses unknown track", function()
  local M = piano_project()
  local r = call(M, "write_midi", { track = "Missing", create = false, notes = { { bar = 1, len = 1, pitch = 60 } } })
  eq(r.ok, false); contains(r.error, "Missing")
end)

test("write_midi adds an item to an existing track without retagging it", function()
  local M, _, T = piano_project()
  local r = call(M, "write_midi", { track = "Piano", notes = { { bar = 3, len = 4, pitch = 60 } } })
  truthy(r.ok, r.error)
  eq(r.result.created_track, false)
  eq(#T.state.tracks[1].items, 2)
  eq(T.state.tracks[1].ext["P_EXT:reaper_ai"], nil)
end)

test("write_midi replace_item swaps notes, keeps pedal unless clear_cc, extends item", function()
  local M, _, T, _, item = piano_project()
  local r = call(M, "write_midi", { replace_item = item.guid, notes = {
    { bar = 1, len = 2, pitch = "C4" }, { bar = 3, beat = 1, len = 4, pitch = "G3" },
  } })
  truthy(r.ok, r.error)
  eq(r.result.replaced, true)
  eq(#item.take.notes, 2); eq(#item.take.ccs, 2, "pedal kept")
  near(item.len, 12 * 0.5, "extended to bar 3")
  local back = call(M, "read_midi", { item = item.guid }).result.items[1]
  eq(back.notes[2].bar, 3); eq(back.notes[2].name, "G3")
  eq(back.cc[1].cc, 64); near(back.cc[1].start, 0)
  r = call(M, "write_midi", { replace_item = item.guid, clear_cc = true, notes = { { bar = 1, len = 1, pitch = 60 } } })
  truthy(r.ok, r.error); eq(#item.take.ccs, 0)
end)

test("write_midi cc and pitch bend encoding", function()
  local M, _, T = piano_project()
  local r = call(M, "write_midi", { track = "Pad (AI)", notes = { { bar = 1, len = 4, pitch = 60 } }, cc = {
    { bar = 1, cc = 64, val = 127 }, { bar = 1, beat = 4, cc = 64, val = 0 },
    { bar = 1, beat = 2, type = "pb", val = -8192 }, { bar = 1, beat = 3, type = "pb", val = 8191 },
    { bar = 1, type = "pc", val = 48 },
  } })
  truthy(r.ok, r.error)
  local back = call(M, "read_midi", { track = "Pad (AI)" }).result.items[1]
  local pbs = {}
  for _, c in ipairs(back.cc) do if c.type == "pb" then pbs[#pbs + 1] = c.val end end
  eq(pbs[1], -8192); eq(pbs[2], 8191)
  local bad = call(M, "write_midi", { track = "Pad (AI)", notes = { { bar = 1, len = 1, pitch = 60 } }, cc = { { bar = 1, cc = 200, val = 1 } } })
  eq(bad.ok, false); contains(bad.error, "cc 番号")
end)

test("write_midi warns when the instrument cannot be found", function()
  local M = piano_project()
  local r = call(M, "write_midi", { track = "Strings (AI)", instrument = "Nonexistent Synth", notes = { { bar = 1, len = 4, pitch = 60 } } })
  truthy(r.ok, r.error)
  eq(#r.result.warnings, 1); contains(r.result.warnings[1], "Nonexistent Synth")
end)

---------------------------------------------------------------------------
-- そのほかの op
---------------------------------------------------------------------------

test("track op mutes, solos, sets volume, renames and protects user tracks", function()
  local M, _, T = piano_project()
  local r = call(M, "track", { track = "Piano", mute = true, solo = true, volume_db = -6, rename = "Piano (rec)" })
  truthy(r.ok, r.error)
  eq(r.result.track, "Piano (rec)"); eq(r.result.mute, true); eq(r.result.solo, true); near(r.result.volume_db, -6)
  r = call(M, "track", { track = "Piano (rec)", delete = true })
  eq(r.ok, false); contains(r.error, "削除しません")
  call(M, "write_midi", { track = "Tmp (AI)", notes = { { bar = 1, len = 1, pitch = 60 } } })
  r = call(M, "track", { track = "Tmp (AI)", delete = true })
  truthy(r.ok, r.error); eq(#T.state.tracks, 2)
  r = call(M, "track", { track = "Vocal", delete = true, force = true })
  truthy(r.ok, r.error); eq(#T.state.tracks, 1)
end)

test("add_markers adds regions on bar boundaries and project lists them", function()
  local M = piano_project()
  local r = call(M, "add_markers", {
    regions = { { name = "Aメロ", start_bar = 1, end_bar = 8 }, { name = "サビ", start_bar = 9, end_bar = 16 } },
    markers = { { name = "brk", bar = 12, beat = 3 } },
  })
  truthy(r.ok, r.error); eq(#r.result.added, 3)
  local p = call(M, "project").result
  eq(#p.markers, 3)
  eq(p.markers[1].name, "Aメロ"); eq(p.markers[1].region, true); eq(p.markers[1].bar, 1); eq(p.markers[1].end_bar, 8)
  eq(p.markers[2].name, "サビ"); eq(p.markers[2].bar, 9); eq(p.markers[2].end_bar, 16)
  eq(p.markers[3].name, "brk"); eq(p.markers[3].bar, 12); near(p.markers[3].beat, 3)
  local bad = call(M, "add_markers", { regions = { { name = "x", start_bar = 5, end_bar = 2 } } })
  eq(bad.ok, false)
end)

test("transport plays from a bar and sets a loop", function()
  local M, _, T = piano_project()
  local r = call(M, "transport", { action = "play", bar = 2, loop_start_bar = 2, loop_end_bar = 3 })
  truthy(r.ok, r.error)
  eq(r.result.cursor.bar, 2)
  eq(T.state.playing, true); near(T.state.cursor, 2.0); near(T.state.loop[1], 2.0); near(T.state.loop[2], 6.0)
  eq(T.state.repeat_on, 1)
  truthy(call(M, "transport", { action = "stop" }).ok); eq(T.state.playing, false)
  local p = call(M, "project").result
  eq(p.time_selection.start_bar, 2); eq(p.time_selection.end_bar, 4)
end)

test("list_fx and add_fx", function()
  local M = piano_project()
  local r = call(M, "list_fx", { instruments = true })
  truthy(r.ok, r.error); eq(r.result.total, 2)
  r = call(M, "list_fx", { filter = "synth" })
  eq(r.result.total, 1); eq(r.result.fx[1].name, "VST: ReaSynth (Cockos)")
  r = call(M, "add_fx", { track = "Piano", fx = "ReaSynth (Cockos)" })
  truthy(r.ok, r.error); eq(r.result.fx[1], "VST: ReaSynth (Cockos)")
  r = call(M, "add_fx", { track = "Piano", fx = "Nope" })
  eq(r.ok, false)
end)

test("lua op returns values, captures print, reports errors", function()
  local M = piano_project()
  local r = call(M, "lua", { code = "print('tracks', reaper.CountTracks(0)); return { n = reaper.CountTracks(0), bar = ai.qn_to_barbeat(4) }" })
  truthy(r.ok, r.error)
  eq(r.result.output, "tracks\t2"); eq(r.result.result.n, 2); eq(r.result.result.bar, 2)
  r = call(M, "lua", { code = "return 1, 2" })
  eq(r.result.result[2], 2)
  r = call(M, "lua", { code = "return false" })
  eq(r.result.result, false)
  r = call(M, "lua", { code = "this is not lua" })
  eq(r.ok, false); contains(r.error, "構文エラー")
  r = call(M, "lua", { code = "error('boom')" })
  eq(r.ok, false); contains(r.error, "boom"); contains(r.error, "traceback")
end)

test("unknown op lists available ops", function()
  local M = piano_project()
  local r = M.handle({ op = "explode" })
  eq(r.ok, false); contains(r.error, "write_midi")
  r = M.handle("nope")
  eq(r.ok, false)
end)

test("an error mid-write still closes the undo block", function()
  local M, R, T = piano_project()
  local orig = R.MIDI_Sort
  rawset(R, "MIDI_Sort", function() error("simulated crash") end)
  local r = call(M, "write_midi", { track = "Crash (AI)", notes = { { bar = 1, len = 1, pitch = 60 } } })
  rawset(R, "MIDI_Sort", orig)
  eq(r.ok, false); contains(r.error, "simulated crash")
  eq(T.state.undo_depth, 0); eq(T.state.ui_refresh, 0)
end)

---------------------------------------------------------------------------
-- ファイル経由のやりとりと常駐ループ
---------------------------------------------------------------------------

local function write_file(path, s) local f = assert(io.open(path, "wb")); f:write(s); f:close() end
local function read_file(path) local f = io.open(path, "rb"); if not f then return nil end; local s = f:read("a"); f:close(); return s end
local function exists(path) local f = io.open(path, "rb"); if f then f:close() return true end return false end

test("process_inbox handles requests, stale requests, bad JSON and ignores other files", function()
  local base = tmpdir()
  local M = piano_project({ base = base })
  local d = M.setup(base)
  write_file(d.inbox .. "/a1.json", M.json.encode({ op = "ping", created = os.time() }))
  write_file(d.inbox .. "/a2.json", M.json.encode({ op = "ping", created = os.time() - 3600 }))
  write_file(d.inbox .. "/a3.json", "{not json")
  write_file(d.inbox .. "/a4.json.tmp", "{}")
  write_file(d.inbox .. "/../evil.json", "{}")
  eq(M.process_inbox(), 3)
  local r1 = M.json.decode(read_file(d.outbox .. "/a1.json"))
  eq(r1.ok, true); eq(r1.id, "a1"); eq(r1.result.project, "Test Song.rpp")
  local r2 = M.json.decode(read_file(d.outbox .. "/a2.json"))
  eq(r2.ok, false); contains(r2.error, "古い")
  local r3 = M.json.decode(read_file(d.outbox .. "/a3.json"))
  eq(r3.ok, false); contains(r3.error, "JSON")
  truthy(exists(d.inbox .. "/a4.json.tmp"), "tmp left alone")
  truthy(not exists(d.inbox .. "/a1.json"), "request consumed")
end)

test("run loop writes heartbeat, serves requests and yields to a newer instance", function()
  local base = tmpdir()
  local R, T = Mock.new({})
  _G.reaper = R
  _G.REAPER_AI_NO_RUN = nil
  _G.REAPER_AI_DIR_OVERRIDE = base
  dofile(SKILL_DIR .. "/reaper/ai_bridge.lua") -- M.run() が走る
  local S = T.state
  truthy(S.deferred, "deferred loop")
  contains(S.console[1], "started")
  for _ = 1, 30 do local fn = S.deferred; S.deferred = nil; fn() end
  local hb = read_file(base .. "/.bridge/heartbeat.json")
  truthy(hb, "heartbeat"); contains(hb, '"version"')
  write_file(base .. "/.bridge/inbox/x.json", '{"op":"ping"}')
  for _ = 1, 5 do local fn = S.deferred; S.deferred = nil; fn() end
  truthy(exists(base .. "/.bridge/outbox/x.json"), "served")
  -- 新しいインスタンスが起動したら古いループは止まる
  R.SetExtState("ReaperAI", "instance", "newer", false)
  local fn = S.deferred; S.deferred = nil; fn()
  eq(S.deferred, nil, "old loop stopped")
  -- atexit は自分のインスタンスでなければハートビートを消さない
  S.atexit()
  truthy(exists(base .. "/.bridge/heartbeat.json"))
end)

print(string.format("lua: %d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
