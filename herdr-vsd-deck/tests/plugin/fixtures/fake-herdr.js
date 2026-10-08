#!/usr/bin/env node
'use strict';

// テスト用の偽 herdr CLI。
//   FAKE_HERDR_SNAPSHOT: `api snapshot` で返す JSON ファイル (無ければ「サーバ未起動」エラー)
//   FAKE_HERDR_LOG:      受け取った引数を1行ずつ追記するファイル

const fs = require('node:fs');

const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) fs.appendFileSync(process.env.FAKE_HERDR_LOG, `${args.join(' ')}\n`);

const fail = (code, message) => {
  process.stderr.write(`${JSON.stringify({ id: 'cli', error: { code, message } })}\n`);
  process.exit(1);
};

if (args[0] === 'api' && args[1] === 'snapshot') {
  const file = process.env.FAKE_HERDR_SNAPSHOT;
  if (!file || !fs.existsSync(file)) fail('server_not_running', 'no herdr server is running at /tmp/herdr.sock; run `herdr` to start or attach it');
  process.stdout.write(`${JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))}\n`);
} else if (args[0] === 'workspace' && args[1] === 'get') {
  const file = process.env.FAKE_HERDR_SNAPSHOT;
  if (!file || !fs.existsSync(file)) fail('server_not_running', 'no herdr server is running');
  const { snapshot } = JSON.parse(fs.readFileSync(file, 'utf8')).result;
  const workspace = snapshot.workspaces.find((w) => w.workspace_id === args[2]);
  if (!workspace) fail('not_found', 'workspace not found');
  process.stdout.write(`${JSON.stringify({ id: 'cli:workspace:get', result: { type: 'workspace_info', workspace } })}\n`);
} else if (args[0] === 'agent' && args[1] === 'focus') {
  process.stdout.write(`${JSON.stringify({ id: 'cli:agent:focus', result: { type: 'ok' } })}\n`);
} else {
  fail('unknown', `unsupported: ${args.join(' ')}`);
}
