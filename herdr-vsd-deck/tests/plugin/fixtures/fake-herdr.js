#!/usr/bin/env node
'use strict';

// テスト用の偽 herdr CLI。
//   FAKE_HERDR_SNAPSHOT: `api snapshot` で返す JSON ファイル (無ければ「サーバ未起動」エラー)
//   FAKE_HERDR_SCREEN:   `pane read` で返す画面のテキストファイル
//   FAKE_HERDR_LOG:      受け取った引数を1行ずつ追記するファイル

const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) fs.appendFileSync(process.env.FAKE_HERDR_LOG, `${args.join(' ')}\n`);

const fail = (code, message) => {
  process.stderr.write(`${JSON.stringify({ id: 'cli', error: { code, message } })}\n`);
  process.exit(1);
};
const snapshot = () => {
  const file = process.env.FAKE_HERDR_SNAPSHOT;
  if (!file || !fs.existsSync(file)) fail('server_not_running', 'no herdr server is running at /tmp/herdr.sock; run `herdr` to start or attach it');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const ok = (id) => process.stdout.write(`${JSON.stringify({ id, result: { type: 'ok' } })}\n`);

const [area, verb, target] = args;
if (area === 'api' && verb === 'snapshot') {
  process.stdout.write(`${JSON.stringify(snapshot())}\n`);
} else if (area === 'workspace' && verb === 'get') {
  const workspace = snapshot().result.snapshot.workspaces.find((w) => w.workspace_id === target);
  if (!workspace) fail('not_found', 'workspace not found');
  process.stdout.write(`${JSON.stringify({ id: 'cli:workspace:get', result: { type: 'workspace_info', workspace } })}\n`);
} else if ((area === 'workspace' || area === 'tab' || area === 'agent') && verb === 'focus') {
  snapshot();
  ok(`cli:${area}:focus`);
} else if (area === 'pane' && verb === 'read') {
  snapshot();
  const file = process.env.FAKE_HERDR_SCREEN;
  process.stdout.write(file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `screen of ${target}\n`);
} else {
  fail('unknown', `unsupported: ${args.join(' ')}`);
}
