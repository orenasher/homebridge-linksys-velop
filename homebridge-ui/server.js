'use strict';

// Server side of the settings screen. The Homebridge UI starts this file as a child
// process and talks to it over the Node IPC channel. The few lines of protocol below
// are the same ones @homebridge/plugin-ui-utils implements; they are written out here
// so the plugin keeps working without installing any dependency.

const { JnapClient, ACTIONS } = require('../lib/jnap');
const { normMac, ruleMacs, deviceView } = require('../lib/parental');
const { describe } = require('../lib/schedule');

async function readRouter(client) {
  try {
    return await client.transaction([{ action: ACTIONS.GET_PARENTAL }, { action: ACTIONS.GET_DEVICES }]);
  } catch (e) {
    if (e.code !== '_ErrorUnknownAction') throw e;
    return client.transaction([{ action: ACTIONS.GET_PARENTAL }, { action: ACTIONS.GET_DEVICES_LEGACY }]);
  }
}

/** Everything the settings screen needs to know about the network, in a compact form. */
async function listDevices(body) {
  const host = String((body && body.host) || '').trim();
  const password = String((body && body.password) || '');
  if (!host || !password) throw new Error('Enter the router address and the admin password first.');
  const client = new JnapClient({ host, port: body.port, username: body.username, password, timeout: 15000 });
  const [settings, list] = await readRouter(client);

  const devices = [];
  for (const d of Array.isArray(list.devices) ? list.devices : []) {
    if (d.nodeType || d.isAuthority || (d.model && d.model.deviceType === 'Infrastructure')) continue; // the mesh nodes themselves
    const macs = new Set();
    for (const i of d.knownInterfaces || []) macs.add(normMac(i.macAddress));
    for (const m of d.knownMACAddresses || []) macs.add(normMac(m));
    for (const c of d.connections || []) macs.add(normMac(c.macAddress));
    macs.delete(null);
    if (!macs.size) continue;
    const user = (d.properties || []).find((p) => p.name === 'userDeviceName' && p.value);
    const connection = (d.connections || [])[0];
    devices.push({
      name: String((user && user.value) || d.friendlyName || '').replace(/�/g, '').replace(/\s+/g, ' ').trim(),
      hostname: d.friendlyName || '',
      macs: [...macs],
      online: (d.connections || []).length > 0,
      ip: (connection && connection.ipAddress) || '',
    });
  }

  const rules = [];
  for (const rule of Array.isArray(settings.rules) ? settings.rules : []) {
    const macs = ruleMacs(rule);
    if (!macs.length) continue;
    const view = deviceView(settings, macs);
    rules.push({ macs, state: view.state, text: view.scheduledWeek ? describe(view.scheduledWeek) : view.state });
  }

  return {
    devices,
    rules,
    maxRules: Number(settings.maxRules) || 0,
    parentalEnabled: settings.isParentalControlEnabled !== false,
  };
}

const handlers = { '/devices': listDevices };

function start() {
  if (!process.send) {
    console.error('This script can only run as a child process of the Homebridge UI.');
    process.exit(1);
  }
  process.on('message', async (request) => {
    if (!request || request.action !== 'request') return;
    const reply = (success, data) => process.send({ action: 'response', payload: { requestId: request.requestId, success, data } });
    const handler = handlers[request.path];
    if (!handler) { reply(false, { message: 'Not Found', path: request.path }); return; }
    try {
      reply(true, await handler(request.body || {}));
    } catch (e) {
      reply(false, { message: e.message, error: { code: e.code || 'ERROR', message: e.message } });
    }
  });
  process.on('disconnect', () => process.exit(0));
  process.send({ action: 'ready', payload: { server: true } });
}

if (require.main === module) start();

module.exports = { listDevices };
