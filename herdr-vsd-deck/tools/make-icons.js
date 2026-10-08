'use strict';

// プラグインの静的アイコン (static/*.svg) を render.js から生成する。
//   node herdr-vsd-deck/tools/make-icons.js

const fs = require('node:fs');
const path = require('node:path');

const pluginDir = path.join(__dirname, '..', 'plugin', 'com.kuruusuniku.herdr-deck.sdPlugin');
const { compactAgent, compactSummary, renderNext, renderMute } = require(path.join(pluginDir, 'plugin', 'render.js'));
const { frameFor, toRects } = require(path.join(pluginDir, 'plugin', 'sprites.js'));

const decode = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));

const sheep = toRects(frameFor('done', 1))
  .map((r) => `<rect x="${12 + r.x * 5}" y="${32 + r.y * 5}" width="${r.w * 5}" height="5" fill="${r.color}"/>`)
  .join('');
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
  + '<rect width="144" height="144" rx="28" fill="#0f1d38"/>' + sheep + '</svg>';

const agent = { id: 'x', paneId: 'w1:p1', workspaceId: 'w1', status: 'working', workspace: 'herdr', task: '', kind: 'claude', name: '', tab: '', project: '' };

const files = {
  'icon.svg': icon,
  'agent.svg': decode(compactAgent(agent, { since: null })),
  'summary.svg': decode(compactSummary({ blocked: 1, working: 2, done: 1, idle: 0, unknown: 0 })),
  'next.svg': decode(renderNext(0)),
  'mute.svg': decode(renderMute(false)),
};
for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(pluginDir, 'static', name), `${svg}\n`);
  console.log(`wrote static/${name}`);
}
