'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nightlyWeek, classify, parseTime, describe, openWeek, pausedWeek, isValidWeek } = require('../lib/schedule');
const { normMac, deviceView, applyWeek } = require('../lib/parental');
const { JnapClient } = require('../lib/jnap');
const { cleanName } = require('../lib/platform');
const { MockRouter, MAC, NIGHT, OPEN, BLOCKED, day } = require('./mock-router');

test('nightly schedule matches what the Linksys app writes for "Pauses at 22:00"', () => {
  assert.deepEqual(nightlyWeek('22:00', '06:00'), day(NIGHT));
  assert.equal(nightlyWeek('08:00', '13:30').sunday, '1'.repeat(16) + '0'.repeat(11) + '1'.repeat(21));
  assert.equal(nightlyWeek('23:30', '00:00').monday, '1'.repeat(47) + '0');
});

test('classify and describe', () => {
  assert.equal(classify(openWeek()), 'open');
  assert.equal(classify(pausedWeek()), 'paused');
  assert.equal(classify(day(NIGHT)), 'scheduled');
  assert.equal(classify({ sunday: '1' }), 'unknown');
  assert.equal(classify(null), 'unknown');
  assert.equal(describe(day(NIGHT)), 'blocked 22:00-06:00');
  assert.equal(describe(nightlyWeek('08:00', '13:30')), 'blocked 08:00-13:30');
});

test('parseTime rejects nonsense', () => {
  assert.equal(parseTime('22:00'), 44);
  assert.equal(parseTime('6:30'), 13);
  assert.equal(parseTime('24:00'), 48);
  for (const bad of ['22', '25:00', '22:15', 'abc', '', undefined]) assert.throws(() => parseTime(bad));
  assert.throws(() => nightlyWeek('22:00', '22:00'));
});

test('MAC normalisation', () => {
  assert.equal(normMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normMac('aabb.ccdd.eeff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normMac('nope'), null);
  assert.equal(normMac(undefined), null);
});

test('HomeKit-safe names keep Hebrew and drop punctuation', () => {
  assert.equal(cleanName('PlayStation (סלון)', 'x'), 'PlayStation סלון');
  assert.equal(cleanName('  --  ', 'Fallback'), 'Fallback');
  assert.equal(cleanName("Dad's iPhone�", 'x'), "Dad's iPhone");
});

test('deviceView reads the router state', () => {
  const s = new MockRouter().state.parental;
  assert.equal(deviceView(s, [MAC.consoleA]).state, 'scheduled');
  assert.equal(deviceView(s, [MAC.consoleC]).state, 'paused');
  assert.equal(deviceView(s, [MAC.plug]).state, 'open');
  assert.equal(deviceView(s, [MAC.phone]).state, 'open');
  assert.equal(deviceView(s, [MAC.consoleBLan, MAC.consoleBWifi]).state, 'scheduled');
  assert.equal(deviceView(s, [MAC.consoleBWifi, MAC.plug]).state, 'mixed');
  assert.equal(deviceView({ ...s, isParentalControlEnabled: false }, [MAC.consoleC]).state, 'disabled');
});

test('applyWeek only touches the requested device', () => {
  const s = new MockRouter().state.parental;
  const before = JSON.parse(JSON.stringify(s));
  const out = applyWeek(s, [MAC.consoleA], pausedWeek());
  assert.deepEqual(s, before, 'input is not mutated');
  assert.equal(out.rules.length, 5);
  assert.deepEqual(out.rules[0].wanSchedule, day(BLOCKED));
  assert.deepEqual(out.rules.slice(1), before.rules.slice(1));
  assert.equal(out.isParentalControlEnabled, true);
  assert.ok(out.rules.every((r) => isValidWeek(r.wanSchedule)));
});

test('applyWeek creates a rule, splits a shared rule and respects the rule limit', () => {
  const s = new MockRouter().state.parental;
  const created = applyWeek(s, [MAC.phone], pausedWeek());
  assert.equal(created.rules.length, 6);
  assert.deepEqual(created.rules[5].macAddresses, [MAC.phone]);
  assert.equal(created.rules[5].description, 'default description');

  const shared = JSON.parse(JSON.stringify(s));
  shared.rules[0].macAddresses.push(MAC.phone);
  const split = applyWeek(shared, [MAC.phone], pausedWeek());
  assert.deepEqual(split.rules[0].macAddresses, [MAC.consoleA]);
  assert.deepEqual(split.rules[0].wanSchedule, day(NIGHT), 'the other device keeps its schedule');
  assert.deepEqual(split.rules[5].wanSchedule, day(BLOCKED));

  assert.throws(() => applyWeek({ ...s, maxRules: 5 }, [MAC.phone], pausedWeek()), /at most 5/);
  assert.throws(() => applyWeek(s, [MAC.consoleA], { sunday: 'x' }), /invalid schedule/);
});

test('applyWeek turns parental controls on only when it needs to block', () => {
  const off = { ...new MockRouter().state.parental, isParentalControlEnabled: false };
  assert.equal(applyWeek(off, [MAC.consoleA], openWeek()).isParentalControlEnabled, false);
  assert.equal(applyWeek(off, [MAC.consoleA], pausedWeek()).isParentalControlEnabled, true);
});

test('a wrong password never leaks into the error message', async () => {
  const router = new MockRouter('right');
  const port = await router.listen();
  try {
    const client = new JnapClient({ host: `127.0.0.1:${port}`, password: 'Wr0ng!pass' });
    for (const run of [
      () => client.call('http://linksys.com/jnap/parentalcontrol/GetParentalControlSettings'),
      () => client.transaction([{ action: 'http://linksys.com/jnap/parentalcontrol/GetParentalControlSettings' }]),
    ]) {
      await assert.rejects(run, (e) => {
        assert.equal(e.code, 'UNAUTHORIZED');
        const b64 = Buffer.from('admin:Wr0ng!pass').toString('base64');
        assert.ok(!e.message.includes(b64) && !e.message.includes('Wr0ng') && !e.message.includes('Basic'));
        return true;
      });
    }
  } finally { await router.close(); }
});

test('unreachable router gives a clear error', async () => {
  const client = new JnapClient({ host: '127.0.0.1', port: 9, password: 'x', timeout: 1000 });
  await assert.rejects(() => client.call('http://linksys.com/jnap/core/GetDeviceInfo'), (e) => ['UNREACHABLE', 'TIMEOUT'].includes(e.code));
});
