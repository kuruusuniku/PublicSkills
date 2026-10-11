-- 統合テスト用: モックの REAPER の上でブリッジを常駐させる。
-- 使い方: lua5.4 serve_mock.lua <skill_dir> <base_dir> <seconds>
-- <base_dir>/stop ができるか、<seconds> 経つと終了する。

local SKILL_DIR, BASE, SECONDS = arg[1], arg[2], tonumber(arg[3] or "60")
package.path = SKILL_DIR .. "/tests/lua/?.lua;" .. package.path
local Mock = require("mock_reaper")

local R, T = Mock.new({ meter = { { 1, 4, 4 }, { 9, 3, 4 } }, project_name = "Demo.rpp" })
_G.reaper = R
_G.REAPER_AI_DIR_OVERRIDE = BASE

-- ピアノで弾いた 4 小節: | C | Am7 | Fmaj7 | G7 | + ペダル
local piano = T.add_track("Piano")
local notes = {}
local function chord(bar, pitches, vel)
  for i, p in ipairs(pitches) do notes[#notes + 1] = { (bar - 1) * 4 + i * 0.01, 3.9, p, vel or 70 } end
end
chord(1, { 48, 55, 64, 67 }); chord(2, { 45, 55, 60, 64 }); chord(3, { 41, 57, 60, 64 }); chord(4, { 43, 53, 59, 62 })
notes[#notes + 1] = { 0, 1, 72, 90 }
notes[#notes + 1] = { 1, 1, 74, 88 }
notes[#notes + 1] = { 2, 2, 76, 92 }
-- 小節ごとに踏み替えるペダル
local pedal = {}
for b = 0, 3 do
  pedal[#pedal + 1] = { b * 4 + 0.05, 64, 127 }
  pedal[#pedal + 1] = { b * 4 + 3.95, 64, 0 }
end
local item = T.add_midi_item(piano, 0, 16, notes, pedal)
item.selected = true

dofile(SKILL_DIR .. "/reaper/ai_bridge.lua")

local function exists(p) local f = io.open(p, "rb"); if f then f:close() return true end return false end
local deadline = os.time() + SECONDS
while os.time() < deadline and not exists(BASE .. "/stop") do
  local fn = T.state.deferred
  T.state.deferred = nil
  if not fn then break end
  fn()
  os.execute("sleep 0.01")
end
