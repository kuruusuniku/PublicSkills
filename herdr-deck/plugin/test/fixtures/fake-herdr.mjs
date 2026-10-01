#!/usr/bin/env node
// テスト用の偽 herdr CLI。FAKE_HERDR_STATE の JSON ({ snapshot, screens }) を本物の herdr と同じ形で返す。
// FAKE_HERDR_STATE が無いときは、herdr サーバーが動いていないときと同じエラーを出す。
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) {
  appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify({ args, session: process.env.HERDR_SESSION ?? null }) + "\n");
}
const stateFile = process.env.FAKE_HERDR_STATE;
if (!stateFile) {
  console.error("no herdr server is running at /tmp/herdr-test.sock; run `herdr` to start or attach it");
  process.exit(1);
}
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const ok = (id, result) => {
  console.log(JSON.stringify({ id, result }));
  process.exit(0);
};
const fail = (id, code, message) => {
  console.error(JSON.stringify({ id, error: { code, message } }));
  process.exit(1);
};
const agent = (target) => state.snapshot.agents.find((a) => a.pane_id === target);

const [group, cmd, target] = args;
if (group === "api" && cmd === "snapshot") ok("cli:api:snapshot", { type: "session_snapshot", snapshot: state.snapshot });
if (group === "pane" && cmd === "read") {
  const text = state.screens?.[target];
  if (text === undefined) fail("cli:pane:read", "pane_not_found", `pane ${target} not found`);
  process.stdout.write(text);
  process.exit(0);
}
if (group === "agent" && cmd === "focus") {
  const a = agent(target);
  if (!a) fail("cli:agent:focus", "agent_not_found", `agent ${target} not found`);
  ok("cli:agent:focus", { type: "agent_info", agent: { ...a, focused: true } });
}
if (group === "tab" && cmd === "focus") {
  const t = state.snapshot.tabs.find((x) => x.tab_id === target);
  if (!t) fail("cli:tab:focus", "tab_not_found", `tab ${target} not found`);
  ok("cli:tab:focus", { type: "tab_info", tab: { ...t, focused: true } });
}
console.error(`unknown command: ${args.join(" ")}`);
process.exit(2);
