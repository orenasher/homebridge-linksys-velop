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
