'use strict';

// A mock Linksys router speaking just enough JNAP for the tests. The fixture has
// the same shape as a real Velop MX4200 answer; the addresses are made up.

const http = require('http');

const B = 'http://linksys.com/jnap/';
const day = (s) => ({ sunday: s, monday: s, tuesday: s, wednesday: s, thursday: s, friday: s, saturday: s });
const NIGHT = '0'.repeat(12) + '1'.repeat(32) + '0'.repeat(4); // blocked 22:00-06:00
const OPEN = '1'.repeat(48);
const BLOCKED = '0'.repeat(48);

const MAC = {
  consoleA: '02:00:00:AA:00:01', // scheduled, online
  consoleBLan: '02:00:00:BB:00:01', // scheduled, online
  consoleBWifi: '02:00:00:BB:00:02', // paused, same console as consoleBLan
  consoleC: '02:00:00:CC:00:01', // paused, offline
  plug: '02:00:00:DD:00:01', // rule with no restrictions
  phone: '02:00:00:EE:00:01', // no rule at all
};

function rule(mac, schedule) {
  return { isEnabled: true, description: 'default description', macAddresses: [mac], wanSchedule: day(schedule), blockedURLs: [] };
}

function device(id, name, mac, { online, userName, props = [] } = {}) {
  const properties = [...props];
  if (userName) properties.unshift({ name: 'userDeviceName', value: userName });
  return {
    deviceID: id, friendlyName: name, knownInterfaces: [{ macAddress: mac, interfaceType: 'Unknown' }],
    connections: online ? [{ macAddress: mac, ipAddress: '10.0.0.50' }] : [], properties, maxAllowedProperties: 16,
  };
}

function fixture() {
  return {
    parental: {
      isParentalControlEnabled: true,
      rules: [
        rule(MAC.consoleA, NIGHT), rule(MAC.consoleBLan, NIGHT), rule(MAC.consoleBWifi, BLOCKED),
        rule(MAC.consoleC, BLOCKED), rule(MAC.plug, OPEN),
      ],
      maxRuleDescriptionLength: 32, maxRuleMACAddresses: 10, maxRuleBlockedURLLength: 32, maxRuleBlockedURLs: 10, maxRules: 14,
    },
    lan: {
      minNetworkPrefixLength: 16, maxNetworkPrefixLength: 30, minAllowedDHCPLeaseMinutes: 1, maxAllowedDHCPLeaseMinutes: 525600,
      maxDHCPReservationDescriptionLength: 63, hostName: 'Linksys00001', isDHCPEnabled: true, networkPrefixLength: 24, ipAddress: '10.0.0.1',
      dhcpSettings: {
        firstClientIPAddress: '10.0.0.10', lastClientIPAddress: '10.0.0.254', leaseMinutes: 1440, dnsServer1: '1.1.1.1',
        reservations: [{ macAddress: MAC.consoleC, ipAddress: '10.0.0.60', description: 'PS5-CC0001' }],
      },
    },
    devices: [
      device('id-a', 'PS5-AA0001', MAC.consoleA, { online: true, userName: 'PlayStation (סלון)', props: [{ name: 'showInPCList', value: 'true' }] }),
      device('id-b1', 'PS5-BB0001', MAC.consoleBLan, { online: true, userName: 'PlayStation (מרתף)', props: [{ name: 'showInPCList', value: 'true' }] }),
      device('id-b2', 'PS5-BB0001', MAC.consoleBWifi, { props: [{ name: 'showInPCList', value: 'true' }, { name: 'blockAllManually', value: 'true' }] }),
      device('id-c', 'PS5-CC0001', MAC.consoleC, { props: [{ name: 'showInPCList', value: 'true' }, { name: 'blockAllManually', value: 'true' }] }),
      device('id-d', 'smart-plug', MAC.plug, { props: [{ name: 'blockAllManually', value: 'true' }] }),
      device('id-e', 'iPhone', MAC.phone, { online: true }),
    ],
  };
}

class MockRouter {
  constructor(password = 'secret') {
    this.password = password;
    this.state = fixture();
    this.calls = [];
    this.rebooted = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)));
  }

  close() { return new Promise((resolve) => this.server.close(resolve)); }

  run(action, request) {
    this.calls.push({ action: action.replace(B, ''), request });
    const s = this.state;
    switch (action.replace(B, '')) {
      case 'parentalcontrol/GetParentalControlSettings':
        return { result: 'OK', output: JSON.parse(JSON.stringify(s.parental)) };
      case 'parentalcontrol/SetParentalControlSettings': {
        if (!Array.isArray(request.rules) || typeof request.isParentalControlEnabled !== 'boolean') return { result: 'ErrorInvalidInput' };
        if (request.rules.length > s.parental.maxRules) return { result: 'ErrorRulesOverlap' };
        for (const r of request.rules) {
          for (const d of Object.values(r.wanSchedule)) if (!/^[01]{48}$/.test(d)) return { result: 'ErrorInvalidInput' };
        }
        s.parental.isParentalControlEnabled = request.isParentalControlEnabled;
        s.parental.rules = JSON.parse(JSON.stringify(request.rules));
        return { result: 'OK', output: {} };
      }
      case 'devicelist/GetDevices3':
        return { result: 'OK', output: { revision: 1, devices: JSON.parse(JSON.stringify(s.devices)) } };
      case 'devicelist/SetDeviceProperties': {
        const d = s.devices.find((x) => x.deviceID === request.deviceID);
        if (!d) return { result: 'ErrorUnknownDevice' };
        for (const p of request.propertiesToModify || []) {
          d.properties = d.properties.filter((x) => x.name !== p.name).concat([p]);
        }
        for (const n of request.propertiesToRemove || []) d.properties = d.properties.filter((x) => x.name !== n);
        return { result: 'OK', output: {} };
      }
      case 'devicelist/DeleteDevice': {
        const d = s.devices.find((x) => x.deviceID === request.deviceID);
        if (!d) return { result: 'ErrorUnknownDevice' };
        if ((d.connections || []).length) return { result: 'ErrorDeviceNotOffline' }; // the router only forgets devices that are gone
        s.devices = s.devices.filter((x) => x !== d);
        return { result: 'OK', output: {} };
      }
      case 'router/GetLANSettings':
        return { result: 'OK', output: JSON.parse(JSON.stringify(s.lan)) };
      case 'router/SetLANSettings': {
        // Mirrors what the real router insists on: every field present, host-name style descriptions, no duplicates.
        const allowed = ['ipAddress', 'networkPrefixLength', 'hostName', 'isDHCPEnabled', 'dhcpSettings'];
        if (Object.keys(request).some((k) => !allowed.includes(k)) || allowed.some((k) => !(k in request))) return { result: 'ErrorInvalidInput' };
        const d = request.dhcpSettings;
        if (!d.firstClientIPAddress || !d.lastClientIPAddress || !d.leaseMinutes || !Array.isArray(d.reservations)) return { result: 'ErrorInvalidInput' };
        const ips = new Set();
        const macs = new Set();
        for (const r of d.reservations) {
          if (!/^[a-zA-Z0-9-]{1,63}$/.test(r.description) || /^-|-$/.test(r.description)) return { result: 'ErrorInvalidDescription' };
          if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(r.macAddress) || !/^10\.0\.0\.\d+$/.test(r.ipAddress)) return { result: 'ErrorInvalidInput' };
          if (ips.has(r.ipAddress) || macs.has(r.macAddress)) return { result: 'ErrorDuplicateReservation' };
          ips.add(r.ipAddress); macs.add(r.macAddress);
        }
        s.lan = { ...s.lan, ...JSON.parse(JSON.stringify(request)) };
        return { result: 'OK', output: {}, ...(this.lanSideEffects ? { sideEffects: this.lanSideEffects } : {}) };
      }
      case 'core/Reboot':
        this.rebooted++;
        return { result: 'OK', output: {} };
      default:
        return { result: '_ErrorUnknownAction' };
    }
  }

  handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (this.down) { req.socket.destroy(); return; }
      if (this.delay) { const ms = this.delay; this.delay = 0; setTimeout(() => this.respond(req, res, chunks, send), ms); return; }
      this.respond(req, res, chunks, send);
    });
  }

  respond(req, res, chunks, send) {
    const auth = req.headers['x-jnap-authorization'];
    const expected = 'Basic ' + Buffer.from(`admin:${this.password}`).toString('base64');
    if (auth !== expected) {
      // The real router echoes the credentials back like this.
      send({ result: '_ErrorUnauthorized', error: `Invalid authorization credentials '${auth}'` });
      return;
    }
    const action = req.headers['x-jnap-action'];
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (action === `${B}core/Transaction`) {
      send({ result: 'OK', responses: body.map((i) => this.run(i.action, i.request)) });
    } else {
      send(this.run(action, body));
    }
  }

  rule(mac) { return this.state.parental.rules.find((r) => r.macAddresses.includes(mac)); }
  props(id) { return Object.fromEntries(this.state.devices.find((d) => d.deviceID === id).properties.map((p) => [p.name, p.value])); }
}

module.exports = { MockRouter, MAC, NIGHT, OPEN, BLOCKED, day };
