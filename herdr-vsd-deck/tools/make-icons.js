'use strict';

// プラグインの静的アイコン (static/*.svg) を render.js から生成する。
//   node herdr-vsd-deck/tools/make-icons.js

const fs = require('node:fs');
const path = require('node:path');

const pluginDir = path.join(__dirname, '..', 'plugin', 'com.kuruusuniku.herdr-deck.sdPlugin');
const { renderTab, renderSpace, renderSummary, renderNext, renderMute } = require(path.join(pluginDir, 'plugin', 'render.js'));
const { frameFor, toRects } = require(path.join(pluginDir, 'plugin', 'sprites.js'));

const decode = (uri) => decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));

// プラグインのアイコン: バンザイしている住人
const resident = toRects(frameFor('done', 1))
  .map((r) => `<rect x="${16 + r.x * 8}" y="${24 + r.y * 8}" width="${r.w * 8}" height="8" fill="${r.color}"/>`)
  .join('');
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
  + '<rect width="144" height="144" rx="28" fill="#0f4034"/>' + resident + '</svg>';

const space = { label: 'スペース', status: 'blocked', tabs: [{ status: 'working' }, { status: 'blocked' }, { status: 'done' }] };

const files = {
  'icon.svg': icon,
  'space.svg': decode(renderSpace(space)),
  'tab.svg': decode(renderTab({ label: 'タブ', status: 'working' })),
  'summary.svg': decode(renderSummary({ blocked: 1, working: 2, done: 1, idle: 0 })),
  'next.svg': decode(renderNext(0)),
  'mute.svg': decode(renderMute(false)),
};
for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(pluginDir, 'static', name), `${svg}\n`);
  console.log(`wrote static/${name}`);
}
