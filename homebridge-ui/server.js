'use strict';

// Server side of the settings screen. The Homebridge UI starts this file as a child
// process and talks to it over the Node IPC channel. The few lines of protocol below
// are the same ones @homebridge/plugin-ui-utils implements; they are written out here
// so the plugin keeps working without installing any dependency.

const { JnapClient, ACTIONS } = require('../lib/jnap');
const { normMac, ruleMacs, deviceView } = require('../lib/parental');
const { describe } = require('../lib/schedule');

async function readRouter(client) {
  const base = [{ action: ACTIONS.GET_PARENTAL }, { action: ACTIONS.GET_DEVICES }];
  try {
    // The LAN settings carry the fixed-IP (DHCP reservation) list.
    return await client.transaction([...base, { action: ACTIONS.GET_LAN }]);
  } catch (e) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'UNREACHABLE' || e.code === 'TIMEOUT') throw e;
  }
  try {
    return await client.transaction(base);
  } catch (e) {
    if (e.code !== '_ErrorUnknownAction') throw e;
    return client.transaction([{ action: ACTIONS.GET_PARENTAL }, { action: ACTIONS.GET_DEVICES_LEGACY }]);
  }
}

function ipToNumber(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return null;
  return m.slice(1).reduce((n, x) => n * 256 + Number(x), 0);
}

/** Can this address be handed to a device on the router's network? */
function usableAddress(ip, lan) {
  const addr = ipToNumber(ip);
  const routerAddr = ipToNumber(lan.ipAddress);
  const bits = Number(lan.networkPrefixLength);
  if (addr === null || routerAddr === null || !(bits >= 8 && bits <= 30)) return false;
  const size = 2 ** (32 - bits);
  const network = Math.floor(routerAddr / size) * size;
  return addr > network && addr < network + size - 1 && addr !== routerAddr;
}

/** The router only accepts host-name style labels for a reservation: letters, digits and dashes. */
function reservationLabel(name, mac, max) {
  const clean = String(name || '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const label = clean || `device-${mac.replace(/:/g, '').slice(-6)}`;
  return label.slice(0, max > 0 ? max : 63).replace(/-+$/g, '');
}

function reservationList(lan) {
  const list = lan && lan.dhcpSettings && Array.isArray(lan.dhcpSettings.reservations) ? lan.dhcpSettings.reservations : [];
  return list.map((r) => ({ mac: normMac(r.macAddress), ip: r.ipAddress, label: r.description || '' })).filter((r) => r.mac && r.ip);
}

/** Everything the settings screen needs to know about the network, in a compact form. */
async function listDevices(body) {
  const host = String((body && body.host) || '').trim();
  const password = String((body && body.password) || '');
  if (!host || !password) throw new Error('Enter the router address and the admin password first.');
  const client = new JnapClient({ host, port: body.port, username: body.username, password, timeout: 15000 });
  const [settings, list, lan] = await readRouter(client);
  const reserved = new Map(reservationList(lan).map((r) => [r.mac, r.ip]));

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
      id: d.deviceID || '',
      name: String((user && user.value) || d.friendlyName || '').replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim(),
      hostname: d.friendlyName || '',
      custom: !!user, // has a name someone typed, as opposed to the name the device reports
      macs: [...macs],
      online: (d.connections || []).length > 0,
      ip: (connection && connection.ipAddress) || '',
      ipMac: (connection && normMac(connection.macAddress)) || [...macs][0], // the address the IP belongs to
      fixedIp: [...macs].map((m) => reserved.get(m)).find(Boolean) || '',
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
    // null when this router does not report its LAN settings: fixed addresses are then left alone
    dhcp: lan ? { enabled: lan.isDHCPEnabled !== false, reservations: reservationList(lan).length } : null,
  };
}

/**
 * Give devices a fixed IP address (a DHCP reservation), or release it. The router keeps the list inside
 * its LAN settings and only accepts the whole block, so everything else is sent back exactly as it was read.
 * body.changes: [{ mac, reserve: true|false, ip, name }]
 */
async function setFixedAddresses(body) {
  const host = String((body && body.host) || '').trim();
  const password = String((body && body.password) || '');
  if (!host || !password) throw new Error('Enter the router address and the admin password first.');
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!changes.length) throw new Error('Nothing to change.');
  const client = new JnapClient({ host, port: body.port, username: body.username, password, timeout: 20000 });

  const lan = await client.call(ACTIONS.GET_LAN);
  const dhcp = lan.dhcpSettings;
  if (!dhcp || !lan.ipAddress || !Array.isArray(dhcp.reservations)) throw new Error('The router did not report its address settings.');
  if (lan.isDHCPEnabled === false) throw new Error('The router is not handing out addresses (DHCP is off), so it cannot keep one fixed.');

  let list = dhcp.reservations.map((r) => ({ ...r }));
  for (const change of changes) {
    const mac = normMac(change && change.mac);
    if (!mac) throw new Error('A device address (MAC) is not valid.');
    list = list.filter((r) => normMac(r.macAddress) !== mac);
    if (!change.reserve) continue;
    const ip = String(change.ip || '').trim();
    if (!usableAddress(ip, lan)) throw new Error(`${ip || 'This address'} is not an address a device can have on this network.`);
    const clash = list.find((r) => r.ipAddress === ip);
    if (clash) throw new Error(`${ip} is already kept for ${clash.description || clash.macAddress}.`);
    list.push({ macAddress: mac, ipAddress: ip, description: reservationLabel(change.name, mac, Number(lan.maxDHCPReservationDescriptionLength)) });
  }

  let sideEffects = [];
  if (JSON.stringify(list) !== JSON.stringify(dhcp.reservations)) {
    const sent = await client.send(ACTIONS.SET_LAN, {
      ipAddress: lan.ipAddress,
      networkPrefixLength: lan.networkPrefixLength,
      hostName: lan.hostName,
      isDHCPEnabled: lan.isDHCPEnabled,
      dhcpSettings: { ...dhcp, reservations: list },
    });
    sideEffects = sent.sideEffects;
  }

  // Read the list back, so the screen shows what the router really stored.
  let reservations = list.map((r) => ({ mac: normMac(r.macAddress), ip: r.ipAddress, label: r.description }));
  let verified = false;
  try {
    reservations = reservationList(await client.call(ACTIONS.GET_LAN));
    verified = true;
  } catch (e) { /* the router may be busy applying the change */ }
  return { reservations, sideEffects, verified };
}

const MAX_NAME = 64;

/** Rename a device on the router: the same change the Linksys app makes when you edit a device name. */
async function renameDevice(body) {
  const host = String((body && body.host) || '').trim();
  const password = String((body && body.password) || '');
  const id = String((body && body.id) || '').trim();
  if (!host || !password) throw new Error('Enter the router address and the admin password first.');
  if (!id) throw new Error('This device cannot be renamed.');
  const name = String((body && body.name) || '').replace(/\s+/g, ' ').trim();
  if (name.length > MAX_NAME) throw new Error(`The name is too long (at most ${MAX_NAME} characters).`);
  const client = new JnapClient({ host, port: body.port, username: body.username, password, timeout: 15000 });
  // An empty name removes the custom name, so the device shows the name it reports itself.
  const change = name ? { propertiesToModify: [{ name: 'userDeviceName', value: name }] } : { propertiesToRemove: ['userDeviceName'] };
  await client.call(ACTIONS.SET_DEVICE_PROPERTIES, { deviceID: id, ...change });
  return { id, name };
}

const MAX_DELETE = 30;

/**
 * Forget old devices: remove them from the router's device list. The router itself only lets go of
 * devices that are not connected. On top of that, nothing with a fixed IP or a Parental Controls rule
 * is removed, nor anything in body.keep (the devices that are in Apple Home).
 * Called in small batches so the settings screen can show progress.
 */
async function forgetDevices(body) {
  const host = String((body && body.host) || '').trim();
  const password = String((body && body.password) || '');
  if (!host || !password) throw new Error('Enter the router address and the admin password first.');
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) throw new Error('Nothing to remove.');
  if (ids.length > MAX_DELETE) throw new Error(`At most ${MAX_DELETE} devices at a time.`);
  const keep = new Set((Array.isArray(body.keep) ? body.keep : []).map(normMac).filter(Boolean));
  const client = new JnapClient({ host, port: body.port, username: body.username, password, timeout: 20000 });

  // Look again right before removing: a device may have come back since the list was shown.
  const [settings, list, lan] = await readRouter(client);
  const inUse = new Set(keep);
  for (const rule of Array.isArray(settings.rules) ? settings.rules : []) ruleMacs(rule).forEach((m) => inUse.add(m));
  for (const r of reservationList(lan)) inUse.add(r.mac);
  const byId = new Map((Array.isArray(list.devices) ? list.devices : []).map((d) => [d.deviceID, d]));

  const removed = [];
  const failed = [];
  const targets = [];
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) { removed.push(id); continue; } // already gone
    const macs = [...(d.knownInterfaces || []).map((i) => normMac(i.macAddress)), ...(d.knownMACAddresses || []).map(normMac)].filter(Boolean);
    if (d.nodeType || d.isAuthority) failed.push({ id, reason: 'part of the Wi-Fi system' });
    else if ((d.connections || []).length) failed.push({ id, reason: 'connected' });
    else if (macs.some((m) => inUse.has(m))) failed.push({ id, reason: 'in use' });
    else targets.push(id);
  }

  if (targets.length) {
    try {
      await client.transaction(targets.map((id) => ({ action: ACTIONS.DELETE_DEVICE, request: { deviceID: id } })));
      removed.push(...targets);
    } catch (first) {
      if (first.code === 'UNAUTHORIZED' || first.code === 'UNREACHABLE' || first.code === 'TIMEOUT') throw first;
      // One refusal fails the whole batch: go one by one to find out which.
      for (const id of targets) {
        try {
          await client.call(ACTIONS.DELETE_DEVICE, { deviceID: id });
          removed.push(id);
        } catch (e) {
          if (e.code === 'ErrorUnknownDevice') removed.push(id);
          else failed.push({ id, reason: e.code || e.message });
        }
      }
    }
  }
  return { removed, failed };
}

const handlers = { '/devices': listDevices, '/rename': renameDevice, '/fixed-ip': setFixedAddresses, '/forget': forgetDevices };

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

module.exports = { listDevices, renameDevice, setFixedAddresses, forgetDevices, reservationLabel, usableAddress };
