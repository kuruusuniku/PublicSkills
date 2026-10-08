'use strict';

// led.js (VSD M18 の RGB ライト) のテスト。node-hid は偽物で代用する。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '../../plugin/com.kuruusuniku.herdr-deck.sdPlugin/plugin');
const { LedRing, buildFrame, ringColor, VENDOR_ID, USAGE_PAGE } = require(path.join(PLUGIN, 'led.js'));

function fakeHid({ devices = [{ vendorId: VENDOR_ID, productId: 0x1000, usagePage: USAGE_PAGE, path: 'm18-vendor' }, { vendorId: VENDOR_ID, productId: 0x1000, usagePage: 0x0001, path: 'm18-keyboard' }], failWrites = 0 } = {}) {
  const log = { opened: [], writes: [], closed: 0 };
  let failing = failWrites;
  class HID {
    constructor(devicePath, options) { log.opened.push({ devicePath, options }); }
    write(bytes) {
      if (failing > 0) { failing -= 1; throw new Error('could not write'); }
      log.writes.push(bytes);
      return bytes.length;
    }
    close() { log.closed += 1; }
  }
  return { hid: { devices: () => devices, HID }, log };
}

test('SETLB frame is report id + CRT\\0\\0SETLB + 24 RGB triples, padded to 1024 bytes', () => {
  const frame = buildFrame([10, 20, 30]);
  assert.equal(frame.length, 1025);
  assert.equal(frame[0], 0x00);
  assert.equal(frame.subarray(1, 11).toString('latin1'), 'CRT\0\0SETLB');
  for (let i = 0; i < 24; i += 1) assert.deepEqual([...frame.subarray(11 + i * 3, 14 + i * 3)], [10, 20, 30]);
  assert.ok(frame.subarray(11 + 72).every((b) => b === 0));
});

test('ringColor picks the most urgent status', () => {
  assert.deepEqual(ringColor({ blocked: 1, done: 1, working: 1 }, 0), [255, 110, 0]);
  assert.deepEqual(ringColor({ blocked: 1 }, 1), [70, 30, 0]);
  assert.deepEqual(ringColor({ blocked: 0, done: 2, working: 1 }, 0), [0, 200, 60]);
  assert.deepEqual(ringColor({ blocked: 0, done: 0, working: 3 }, 0), [0, 50, 220]);
  assert.deepEqual(ringColor({ blocked: 0, done: 0, working: 0, idle: 4 }, 0), [0, 0, 0]);
});

test('opens the vendor interface non-exclusively so VSD Craft keeps the device', () => {
  const { hid, log } = fakeHid();
  const ring = new LedRing({ hid });
  assert.equal(ring.show([0, 50, 220]), true);
  assert.deepEqual(log.opened, [{ devicePath: 'm18-vendor', options: { nonExclusive: true } }]);
  assert.equal(log.writes[0].length, 1025);
});

test('re-sends a lit colour every 2s, sends "off" once, and skips duplicates', () => {
  let now = 0;
  const { hid, log } = fakeHid();
  const ring = new LedRing({ hid, now: () => now });
  ring.show([0, 200, 60]);
  now = 1000;
  assert.equal(ring.show([0, 200, 60]), false);
  now = 2100;
  assert.equal(ring.show([0, 200, 60]), true, 'keepalive so VSD Craft cannot leave it overwritten');
  assert.equal(ring.show([0, 0, 0]), true);
  now = 99999;
  assert.equal(ring.show([0, 0, 0]), false, 'off is not re-asserted');
  assert.equal(log.writes.length, 3);
});

test('a failed write is logged once and the device is reopened next time', () => {
  const lines = [];
  const { hid, log } = fakeHid({ failWrites: 2 });
  const ring = new LedRing({ hid, log: (l) => lines.push(l) });
  assert.equal(ring.show([1, 2, 3]), false);
  assert.equal(ring.show([1, 2, 3]), false);
  assert.equal(ring.show([1, 2, 3]), true);
  assert.equal(log.opened.length, 3);
  assert.equal(lines.filter((l) => l.includes('書き込めません')).length, 1);
  assert.ok(lines.some((l) => l.includes('再接続')));
});

test('no M18 attached or no node-hid: nothing breaks', () => {
  const lines = [];
  const { hid } = fakeHid({ devices: [] });
  assert.equal(new LedRing({ hid, log: (l) => lines.push(l) }).show([1, 1, 1]), false);
  assert.match(lines[0], /VSD M18 が見つかりません/);
  const noHid = new LedRing({ hid: null, log: (l) => lines.push(l) });
  assert.equal(noHid.show([1, 1, 1]), false);
  assert.match(lines.at(-1), /node-hid が無い/);
});
