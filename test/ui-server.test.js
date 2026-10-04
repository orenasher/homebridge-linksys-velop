'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fork } = require('child_process');
const { MockRouter, MAC } = require('./mock-router');

// Talks to homebridge-ui/server.js the same way the Homebridge UI does.
function startUiServer(t) {
  const child = fork(path.join(__dirname, '..', 'homebridge-ui', 'server.js'), [], { silent: true });
  t.after(() => child.kill());
  const waiting = new Map();
  let seq = 0;
  const ready = new Promise((resolve) => {
    child.on('message', (m) => {
      if (m.action === 'ready') resolve();
      if (m.action === 'response' && waiting.has(m.payload.requestId)) {
        waiting.get(m.payload.requestId)(m.payload);
        waiting.delete(m.payload.requestId);
      }
    });
  });
  const request = async (p, body) => {
    await ready;
    const requestId = `r${++seq}`;
    return new Promise((resolve) => { waiting.set(requestId, resolve); child.send({ action: 'request', requestId, path: p, body }); });
  };
  return { request, child };
}

test('settings screen server lists the devices on the network', async (t) => {
  const router = new MockRouter('secret');
  router.state.devices.push({ deviceID: 'node', friendlyName: 'Velop', nodeType: 'Master', isAuthority: true, knownInterfaces: [{ macAddress: '02:00:00:FF:00:01' }], connections: [{ macAddress: '02:00:00:FF:00:01', ipAddress: '10.0.0.1' }] });
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);

  const ok = await ui.request('/devices', { host: `127.0.0.1:${port}`, password: 'secret' });
  assert.equal(ok.success, true);
  const { devices, rules, maxRules, parentalEnabled } = ok.data;
  assert.equal(devices.length, 6, 'the mesh node itself is left out');
  const phone = devices.find((d) => d.macs.includes(MAC.phone));
  assert.deepEqual({ name: phone.name, online: phone.online, ip: phone.ip }, { name: 'iPhone', online: true, ip: '10.0.0.50' });
  assert.equal(devices.find((d) => d.macs.includes(MAC.consoleA)).name, 'PlayStation (סלון)');
  assert.equal(rules.length, 5);
  assert.deepEqual(rules.map((r) => r.text), ['blocked 22:00-06:00', 'blocked 22:00-06:00', 'paused', 'paused', 'open']);
  assert.equal(maxRules, 14);
  assert.equal(parentalEnabled, true);
  assert.equal(router.calls.filter((c) => /\/Set/.test(c.action)).length, 0, 'read only');
});

test('settings screen server reports problems without leaking the password', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);

  const bad = await ui.request('/devices', { host: `127.0.0.1:${port}`, password: 'Wr0ng!pass' });
  assert.equal(bad.success, false);
  assert.match(bad.data.message, /rejected the password/);
  assert.ok(!JSON.stringify(bad).includes('Wr0ng') && !JSON.stringify(bad).includes(Buffer.from('admin:Wr0ng!pass').toString('base64')));

  const empty = await ui.request('/devices', { host: '', password: '' });
  assert.equal(empty.success, false);
  assert.match(empty.data.message, /router address/);

  const missing = await ui.request('/nope', {});
  assert.equal(missing.success, false);
});

test('settings screen server renames a device on the router', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const login = { host: `127.0.0.1:${port}`, password: 'secret' };

  const list = await ui.request('/devices', login);
  const phone = list.data.devices.find((d) => d.macs.includes(MAC.phone));
  assert.equal(phone.id, 'id-e');

  const ok = await ui.request('/rename', { ...login, id: phone.id, name: '  האייפון   של אבא ' });
  assert.deepEqual(ok, { requestId: ok.requestId, success: true, data: { id: 'id-e', name: 'האייפון של אבא' } });
  assert.equal(router.props('id-e').userDeviceName, 'האייפון של אבא');
  const after = await ui.request('/devices', login);
  assert.equal(after.data.devices.find((d) => d.id === 'id-e').name, 'האייפון של אבא');

  // an existing custom name is replaced, and the other properties are left alone
  await ui.request('/rename', { ...login, id: 'id-a', name: 'Console' });
  assert.deepEqual(router.props('id-a'), { showInPCList: 'true', userDeviceName: 'Console' });

  // an empty name goes back to the name the device reports
  const cleared = await ui.request('/rename', { ...login, id: 'id-e', name: '   ' });
  assert.equal(cleared.success, true);
  assert.ok(!('userDeviceName' in router.props('id-e')));
  const back = await ui.request('/devices', login);
  assert.equal(back.data.devices.find((d) => d.id === 'id-e').name, 'iPhone');

  assert.equal(router.calls.filter((c) => c.action.includes('ParentalControlSettings') && c.action.includes('/Set')).length, 0, 'rules are never touched');
});

test('settings screen server refuses bad rename requests', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const login = { host: `127.0.0.1:${port}`, password: 'secret' };

  const long = await ui.request('/rename', { ...login, id: 'id-e', name: 'x'.repeat(65) });
  assert.equal(long.success, false);
  assert.match(long.data.message, /too long/);
  const noId = await ui.request('/rename', { ...login, name: 'x' });
  assert.equal(noId.success, false);
  const unknown = await ui.request('/rename', { ...login, id: 'nope', name: 'x' });
  assert.equal(unknown.success, false);
  assert.match(unknown.data.message, /refused/);
  const wrong = await ui.request('/rename', { host: login.host, password: 'Wr0ng!pass', id: 'id-e', name: 'x' });
  assert.equal(wrong.success, false);
  assert.ok(!JSON.stringify(wrong).includes('Wr0ng'));
  assert.ok(!('userDeviceName' in router.props('id-e')), 'nothing was written');
});

// ---------------------------------------------------------------- fixed IP addresses

const lanSets = (router) => router.calls.filter((c) => c.action === 'router/SetLANSettings');

test('settings screen server reports which devices have a fixed IP', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const { data } = await ui.request('/devices', { host: `127.0.0.1:${port}`, password: 'secret' });
  assert.equal(data.devices.find((d) => d.macs.includes(MAC.consoleC)).fixedIp, '10.0.0.60');
  assert.equal(data.devices.find((d) => d.macs.includes(MAC.phone)).fixedIp, '');
  assert.deepEqual(data.dhcp, { enabled: true, reservations: 1 });
});

test('settings screen server makes an IP fixed and releases it, leaving the other LAN settings alone', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const login = { host: `127.0.0.1:${port}`, password: 'secret' };
  const before = JSON.parse(JSON.stringify(router.state.lan));

  const one = await ui.request('/fixed-ip', { ...login, changes: [{ mac: MAC.phone.toLowerCase(), reserve: true, ip: '10.0.0.50', name: 'האייפון של אבא' }] });
  assert.equal(one.success, true);
  assert.equal(one.data.verified, true);
  assert.deepEqual(one.data.sideEffects, []);
  assert.deepEqual(router.state.lan.dhcpSettings.reservations, [
    { macAddress: MAC.consoleC, ipAddress: '10.0.0.60', description: 'PS5-CC0001' },
    { macAddress: MAC.phone, ipAddress: '10.0.0.50', description: 'device-EE0001' },
  ]);
  const rest = (lan) => ({ ...lan, dhcpSettings: { ...lan.dhcpSettings, reservations: null } });
  assert.deepEqual(rest(router.state.lan), rest(before), 'address range, DNS, host name and the rest are untouched');
  assert.deepEqual(Object.keys(lanSets(router)[0].request).sort(), ['dhcpSettings', 'hostName', 'ipAddress', 'isDHCPEnabled', 'networkPrefixLength']);
  assert.equal(lanSets(router)[0].request.dhcpSettings.dnsServer1, '1.1.1.1');

  // several changes are written in one go
  const many = await ui.request('/fixed-ip', { ...login, changes: [
    { mac: MAC.consoleA, reserve: true, ip: '10.0.0.70', name: 'PlayStation (סלון)' },
    { mac: MAC.consoleC, reserve: false },
    { mac: MAC.phone, reserve: true, ip: '10.0.0.51', name: 'iPhone' },
  ] });
  assert.equal(many.success, true);
  assert.equal(lanSets(router).length, 2);
  assert.deepEqual(many.data.reservations, [
    { mac: MAC.consoleA, ip: '10.0.0.70', label: 'PlayStation' },
    { mac: MAC.phone, ip: '10.0.0.51', label: 'iPhone' },
  ]);

  // releasing something that is not fixed writes nothing
  const noop = await ui.request('/fixed-ip', { ...login, changes: [{ mac: MAC.plug, reserve: false }] });
  assert.equal(noop.success, true);
  assert.equal(lanSets(router).length, 2);
  assert.equal(router.calls.filter((c) => c.action.includes('ParentalControlSettings') && c.action.includes('/Set')).length, 0);
});

test('settings screen server refuses fixed addresses that would break something', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const login = { host: `127.0.0.1:${port}`, password: 'secret' };
  const refuse = async (change, pattern) => {
    const r = await ui.request('/fixed-ip', { ...login, changes: [change] });
    assert.equal(r.success, false, JSON.stringify(change));
    assert.match(r.data.message, pattern);
  };
  await refuse({ mac: MAC.phone, reserve: true, ip: '10.0.0.60', name: 'x' }, /already kept for PS5-CC0001/);
  await refuse({ mac: MAC.phone, reserve: true, ip: '10.0.0.1', name: 'x' }, /not an address a device can have/);
  await refuse({ mac: MAC.phone, reserve: true, ip: '10.0.0.255', name: 'x' }, /not an address/);
  await refuse({ mac: MAC.phone, reserve: true, ip: '192.168.1.5', name: 'x' }, /not an address/);
  await refuse({ mac: MAC.phone, reserve: true, ip: '', name: 'x' }, /not an address/);
  await refuse({ mac: 'zz', reserve: true, ip: '10.0.0.50' }, /not valid/);
  const empty = await ui.request('/fixed-ip', { ...login, changes: [] });
  assert.equal(empty.success, false);
  assert.equal(lanSets(router).length, 0, 'nothing was written');

  router.state.lan.isDHCPEnabled = false;
  await refuse({ mac: MAC.phone, reserve: true, ip: '10.0.0.50', name: 'x' }, /DHCP is off/);
  assert.equal(lanSets(router).length, 0);
});

test('settings screen server passes on what the router says the change disturbs', async (t) => {
  const router = new MockRouter('secret');
  router.lanSideEffects = ['WirelessInterruption'];
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const r = await ui.request('/fixed-ip', { host: `127.0.0.1:${port}`, password: 'secret', changes: [{ mac: MAC.phone, reserve: true, ip: '10.0.0.50', name: 'iPhone' }] });
  assert.deepEqual(r.data.sideEffects, ['WirelessInterruption']);
});

test('settings screen server still lists devices on a router without LAN settings', async (t) => {
  const router = new MockRouter('secret');
  const realRun = router.run.bind(router);
  router.run = (action, request) => (action.endsWith('GetLANSettings') ? { result: '_ErrorUnknownAction' } : realRun(action, request));
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const { success, data } = await ui.request('/devices', { host: `127.0.0.1:${port}`, password: 'secret' });
  assert.equal(success, true);
  assert.equal(data.devices.length, 6);
  assert.equal(data.dhcp, null);
});

// ---------------------------------------------------------------- forgetting old devices

function withOldDevices(router) {
  const old = (id, mac, extra = {}) => ({ deviceID: id, friendlyName: id, knownInterfaces: [{ macAddress: mac }], connections: [], properties: [], ...extra });
  router.state.devices.push(
    old('old-1', '02:00:00:01:00:01'),
    old('old-2', '02:00:00:01:00:02'),
    old('old-named', '02:00:00:01:00:03', { properties: [{ name: 'userDeviceName', value: 'מחשב ישן' }] }),
    old('old-kept', '02:00:00:01:00:04'),
  );
}

test('settings screen server forgets old devices and nothing else', async (t) => {
  const router = new MockRouter('secret');
  withOldDevices(router);
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const login = { host: `127.0.0.1:${port}`, password: 'secret' };

  const list = await ui.request('/devices', login);
  assert.equal(list.data.devices.find((d) => d.id === 'old-named').custom, true);
  assert.equal(list.data.devices.find((d) => d.id === 'old-1').custom, false);

  const r = await ui.request('/forget', { ...login, keep: ['02:00:00:01:00:04'],
    ids: ['old-1', 'old-2', 'old-named', 'old-kept', 'id-e', 'id-c', 'id-b2', 'id-d', 'gone-already'] });
  assert.equal(r.success, true);
  assert.deepEqual(r.data.removed.sort(), ['gone-already', 'old-1', 'old-2', 'old-named']);
  assert.deepEqual(Object.fromEntries(r.data.failed.map((f) => [f.id, f.reason])), {
    'old-kept': 'in use', // in Apple Home
    'id-e': 'connected',
    'id-c': 'in use', // fixed IP and a rule
    'id-b2': 'in use', // Parental Controls rule
    'id-d': 'in use',
  });
  assert.deepEqual(router.state.devices.map((d) => d.deviceID), ['id-a', 'id-b1', 'id-b2', 'id-c', 'id-d', 'id-e', 'old-kept']);
  assert.equal(router.calls.filter((c) => /\/Set/.test(c.action)).length, 0, 'no settings were changed');
});

test('settings screen server keeps going when the router refuses one device', async (t) => {
  const router = new MockRouter('secret');
  withOldDevices(router);
  const realRun = router.run.bind(router);
  // old-2 comes back online between our check and the removal
  let reads = 0;
  router.run = (action, request) => {
    if (action.endsWith('GetDevices3') && ++reads === 1) {
      const out = realRun(action, request);
      router.state.devices.find((d) => d.deviceID === 'old-2').connections = [{ macAddress: '02:00:00:01:00:02', ipAddress: '10.0.0.9' }];
      return out;
    }
    return realRun(action, request);
  };
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const r = await ui.request('/forget', { host: `127.0.0.1:${port}`, password: 'secret', ids: ['old-1', 'old-2', 'old-kept'] });
  assert.deepEqual(r.data.removed.sort(), ['old-1', 'old-kept']);
  assert.deepEqual(r.data.failed, [{ id: 'old-2', reason: 'ErrorDeviceNotOffline' }]);
});

test('settings screen server refuses bad forget requests', async (t) => {
  const router = new MockRouter('secret');
  const port = await router.listen();
  t.after(() => router.close());
  const ui = startUiServer(t);
  const login = { host: `127.0.0.1:${port}`, password: 'secret' };
  assert.equal((await ui.request('/forget', { ...login, ids: [] })).success, false);
  const many = await ui.request('/forget', { ...login, ids: Array.from({ length: 31 }, (_, i) => `x${i}`) });
  assert.match(many.data.message, /At most 30/);
  const wrong = await ui.request('/forget', { host: login.host, password: 'Wr0ng!pass', ids: ['id-c'] });
  assert.equal(wrong.success, false);
  assert.ok(!JSON.stringify(wrong).includes('Wr0ng'));
  assert.equal(router.state.devices.length, 6);
});
