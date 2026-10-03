'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LinksysVelopPlatform } = require('../lib/platform');
const { makeApi, makeLog, Service, Characteristic } = require('./fake-homebridge');
const { MockRouter, MAC, NIGHT, OPEN, BLOCKED, day } = require('./mock-router');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); }
}

async function boot(t, config = {}, opts = {}) {
  const router = opts.router || new MockRouter('secret');
  const port = opts.port || await router.listen();
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'velop-'));
  const api = makeApi(dir);
  const log = makeLog();
  const platform = new LinksysVelopPlatform(log, { platform: 'LinksysVelop', host: `127.0.0.1:${port}`, password: 'secret', ...config }, api);
  for (const a of opts.cached || []) { platform.configureAccessory(a); api.registered.push(a); }
  api.emit('didFinishLaunching');
  t.after(async () => { platform.stop(); if (!opts.router) await router.close(); });
  if (!opts.noWait) await until(() => platform.firstPollDone);
  const acc = (name) => api.registered.find((a) => a.displayName === name);
  const sw = (name, subtype) => acc(name).getServiceById(Service.Switch, subtype).getCharacteristic(Characteristic.On);
  const sets = () => router.calls.filter((c) => c.action === 'parentalcontrol/SetParentalControlSettings');
  return { router, port, dir, api, log, platform, acc, sw, sets };
}

const LIVING = 'PlayStation סלון';
const BASEMENT = 'PlayStation מרתף';

test('discovers every device under parental controls and reads its state', async (t) => {
  const { api, sw, acc, log } = await boot(t);
  assert.deepEqual(api.registered.map((a) => a.displayName).sort(), [LIVING, BASEMENT, 'PS5 BB0001', 'PS5 CC0001', 'smart plug'].sort());
  assert.equal(await sw(LIVING, 'pause').get(), false);
  assert.equal(await sw(LIVING, 'schedule').get(), true);
  assert.equal(await sw('PS5 CC0001', 'pause').get(), true);
  assert.equal(await sw('PS5 CC0001', 'schedule').get(), false);
  assert.equal(await sw('smart plug', 'pause').get(), false);
  assert.equal(await sw('smart plug', 'schedule').get(), false);
  const occ = (n) => acc(n).getServiceById(Service.OccupancySensor, 'presence').getCharacteristic(Characteristic.OccupancyDetected).get();
  assert.equal(await occ(LIVING), 1);
  assert.equal(await occ('PS5 CC0001'), 0);
  assert.equal(acc(LIVING).getServiceById(Service.Switch, 'pause').getCharacteristic(Characteristic.ConfiguredName).value, `${LIVING} Pause`);
  assert.ok(!log.text().includes('secret'));
});

test('pause and resume restores the schedule and leaves other devices alone', async (t) => {
  const { router, sw, sets, dir } = await boot(t);
  const others = () => JSON.stringify(router.state.parental.rules.slice(1));
  const before = others();

  await sw(LIVING, 'pause').set(true);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(BLOCKED));
  assert.equal(others(), before);
  assert.equal(sets().length, 1);
  await until(() => router.props('id-a').blockAllManually === 'true');
  assert.equal(await sw(LIVING, 'schedule').get(), true, 'schedule switch keeps its state while paused');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'linksys-velop.json'), 'utf8'));
  assert.deepEqual(saved.devices[MAC.consoleA].schedule, day(NIGHT));

  await sw(LIVING, 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(NIGHT));
  assert.equal(others(), before);
  await until(() => !('blockAllManually' in router.props('id-a')));
  assert.equal(router.props('id-a').showInPCList, 'true');
});

test('schedule switch turns the schedule off and back on', async (t) => {
  const { router, sw } = await boot(t);
  await sw(LIVING, 'schedule').set(false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(OPEN));
  assert.equal(await sw(LIVING, 'pause').get(), false);
  await sw(LIVING, 'schedule').set(true);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(NIGHT));
});

test('schedule switch while paused does not lift the pause', async (t) => {
  const { router, sw, sets } = await boot(t);
  // PS5 CC0001 is paused and its schedule is unknown.
  await sw('PS5 CC0001', 'schedule').set(true);
  assert.deepEqual(router.rule(MAC.consoleC).wanSchedule, day(BLOCKED));
  assert.equal(sets().length, 0, 'nothing written');
  await sw('PS5 CC0001', 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleC).wanSchedule, day(NIGHT), 'default 22:00-06:00 schedule applied');
  // ...and with the schedule switch off, resuming opens the device completely.
  await sw('PS5 BB0001', 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleBWifi).wanSchedule, day(OPEN));
});

test('a scene flipping several switches writes to the router once', async (t) => {
  const { router, sw, sets } = await boot(t);
  await Promise.all([sw(LIVING, 'pause').set(true), sw(BASEMENT, 'pause').set(true), sw('smart plug', 'pause').set(true)]);
  assert.equal(sets().length, 1);
  for (const mac of [MAC.consoleA, MAC.consoleBLan, MAC.plug]) assert.deepEqual(router.rule(mac).wanSchedule, day(BLOCKED));
  await Promise.all([sw(LIVING, 'pause').set(false), sw(BASEMENT, 'pause').set(false), sw('smart plug', 'pause').set(false)]);
  assert.equal(sets().length, 2);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(NIGHT));
  assert.deepEqual(router.rule(MAC.plug).wanSchedule, day(OPEN));
});

test('changes made in the Linksys app are picked up and survive a pause', async (t) => {
  const { router, sw, platform } = await boot(t);
  const custom = day('0'.repeat(14) + '1'.repeat(28) + '0'.repeat(6)); // 21:00-07:00
  router.rule(MAC.consoleA).wanSchedule = custom;
  await platform.poll();
  await sw(LIVING, 'pause').set(true);
  await sw(LIVING, 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, custom);

  // Changed in the app after our last poll, right before a pause from HomeKit.
  const later = day('0'.repeat(16) + '1'.repeat(32));
  router.rule(MAC.consoleA).wanSchedule = later;
  await sw(LIVING, 'pause').set(true);
  await sw(LIVING, 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, later);

  // Paused in the app.
  await until(() => !platform.writing);
  router.rule(MAC.consoleA).wanSchedule = day(BLOCKED);
  await platform.poll();
  assert.equal(await sw(LIVING, 'pause').get(), true);
  assert.equal(await sw(LIVING, 'schedule').get(), true);
});

test('two addresses of one console can be combined into one switch', async (t) => {
  const { router, api, sw } = await boot(t, { devices: [{ name: 'Basement PS5', macs: [MAC.consoleBLan.toLowerCase(), MAC.consoleBWifi] }] });
  assert.equal(api.registered.length, 4);
  assert.equal(await sw('Basement PS5', 'pause').get(), false, 'only one of the two addresses is blocked');
  await sw('Basement PS5', 'pause').set(true);
  assert.deepEqual(router.rule(MAC.consoleBLan).wanSchedule, day(BLOCKED));
  assert.deepEqual(router.rule(MAC.consoleBWifi).wanSchedule, day(BLOCKED));
  await sw('Basement PS5', 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleBLan).wanSchedule, day(NIGHT));
  assert.deepEqual(router.rule(MAC.consoleBWifi).wanSchedule, day(NIGHT));
  assert.equal(router.state.parental.rules.length, 5);
});

test('a device with no rule yet, options per device, hidden devices and custom labels', async (t) => {
  const { router, api, acc, sw } = await boot(t, {
    exclude: [MAC.plug],
    labels: { pause: 'השהיה', schedule: '' },
    presenceSensorType: 'contact',
    devices: [{ name: 'Phone', macs: [MAC.phone], scheduleSwitch: false, pauseStart: '20:00', pauseEnd: '07:30' },
      { name: 'Broken', macs: ['zz'] }],
  });
  assert.equal(api.registered.length, 5);
  assert.ok(!acc('smart plug'));
  assert.ok(!acc('Phone').getServiceById(Service.Switch, 'schedule'));
  assert.equal(acc('Phone').getServiceById(Service.Switch, 'pause').displayName, 'Phone השהיה');
  assert.equal(acc(LIVING).getServiceById(Service.Switch, 'schedule').displayName, `${LIVING} Schedule`);
  const contact = acc('Phone').getServiceById(Service.ContactSensor, 'presence').getCharacteristic(Characteristic.ContactSensorState);
  assert.equal(await contact.get(), 0);
  await sw('Phone', 'pause').set(true);
  assert.equal(router.state.parental.rules.length, 6);
  assert.deepEqual(router.rule(MAC.phone).wanSchedule, day(BLOCKED));
  await until(() => router.props('id-e').showInPCList === 'true');
});

test('"on = internet allowed" mode inverts the pause switch', async (t) => {
  const { router, sw } = await boot(t, { pauseSwitchMode: 'internet' });
  assert.equal(await sw(LIVING, 'pause').get(), true);
  assert.equal(await sw('PS5 CC0001', 'pause').get(), false);
  await sw(LIVING, 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(BLOCKED));
  assert.equal(await sw(LIVING, 'pause').get(), false);
});

test('errors reach HomeKit and nothing is written when the router is down', async (t) => {
  const { router, sw, log, platform } = await boot(t);
  router.down = true;
  platform.client.timeout = 500;
  await assert.rejects(() => sw(LIVING, 'pause').set(true), /HAP status/);
  router.down = false;
  await platform.poll();
  assert.equal(await sw(LIVING, 'pause').get(), false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(NIGHT));
  assert.ok(log.text().includes('Change failed'));
});

test('a slow router does not make HomeKit time out', async (t) => {
  const { router, sw, platform } = await boot(t);
  platform.setWaitMs = 150;
  router.delay = 700;
  const started = Date.now();
  await sw(LIVING, 'pause').set(true);
  assert.ok(Date.now() - started < 650, 'HomeKit was answered before the router finished');
  await until(() => router.rule(MAC.consoleA).wanSchedule.sunday === BLOCKED);
  await until(() => !platform.writing);
  assert.equal(await sw(LIVING, 'pause').get(), true);
});

test('wrong password: clear message, no credentials in the log, switches report an error', async (t) => {
  const router = new MockRouter('other');
  const port = await router.listen();
  t.after(() => router.close());
  const { log, api, platform } = await boot(t, { password: 'Sup3r@Secret' }, { router, port, noWait: true });
  await until(() => platform.reachable === false);
  const text = log.text();
  assert.match(text, /rejected the password/);
  assert.ok(!text.includes('Sup3r') && !text.includes(Buffer.from('admin:Sup3r@Secret').toString('base64')));
  assert.equal(api.registered.length, 0);
});

test('restart: accessories are reused, work before the router answers, and stale ones go away', async (t) => {
  const first = await boot(t, { rebootSwitch: true });
  assert.equal(first.api.registered.length, 6);
  await first.sw(LIVING, 'pause').set(true);
  first.platform.stop();

  const router = first.router;
  router.down = true;
  const second = await boot(t, { exclude: [MAC.plug] }, { router, port: first.port, dir: first.dir, cached: first.api.registered, noWait: true });
  // Router still unreachable: the switch exists already and reports the failure instead of ignoring the tap.
  second.platform.client.timeout = 300;
  await assert.rejects(() => second.sw(LIVING, 'pause').set(false), /HAP status/);
  router.down = false;
  await second.platform.poll();
  assert.deepEqual(second.api.registered.map((a) => a.displayName).sort(), [LIVING, BASEMENT, 'PS5 BB0001', 'PS5 CC0001'].sort());
  assert.equal(await second.sw(LIVING, 'pause').get(), true);
  assert.equal(await second.sw(LIVING, 'schedule').get(), true, 'remembered across the restart');
  await second.sw(LIVING, 'pause').set(false);
  assert.deepEqual(router.rule(MAC.consoleA).wanSchedule, day(NIGHT), 'schedule restored from the saved file');
});

test('restart switch reboots the router and turns itself off', async (t) => {
  const { router, acc } = await boot(t, { rebootSwitch: true });
  const on = acc('Restart Router').getServiceById(Service.Switch, 'restart').getCharacteristic(Characteristic.On);
  await on.set(true);
  assert.equal(router.rebooted, 1);
  await on.set(false);
  assert.equal(router.rebooted, 1);
  assert.equal(await on.get(), false);
});

test('parental controls switched off on the router', async (t) => {
  const router = new MockRouter('secret');
  router.state.parental.isParentalControlEnabled = false;
  const port = await router.listen();
  t.after(() => router.close());
  const { sw, log } = await boot(t, {}, { router, port });
  assert.equal(await sw('PS5 CC0001', 'pause').get(), false, 'nothing is actually blocked');
  await sw(LIVING, 'pause').set(true);
  assert.equal(router.state.parental.isParentalControlEnabled, true);
  assert.match(log.text(), /switched them on/);
});

test('not configured: stays quiet', () => {
  const api = makeApi(os.tmpdir());
  const log = makeLog();
  const p = new LinksysVelopPlatform(log, { platform: 'LinksysVelop' }, api);
  api.emit('didFinishLaunching');
  assert.equal(p.disabled, true);
  assert.match(log.text(), /Not configured/);
});
