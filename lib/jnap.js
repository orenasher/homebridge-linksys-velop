'use strict';

const http = require('http');

const BASE = 'http://linksys.com/jnap/';
const ACTIONS = {
  TRANSACTION: `${BASE}core/Transaction`,
  REBOOT: `${BASE}core/Reboot`,
  GET_DEVICE_INFO: `${BASE}core/GetDeviceInfo`,
  GET_DEVICES: `${BASE}devicelist/GetDevices3`,
  GET_DEVICES_LEGACY: `${BASE}devicelist/GetDevices`,
  SET_DEVICE_PROPERTIES: `${BASE}devicelist/SetDeviceProperties`,
  GET_PARENTAL: `${BASE}parentalcontrol/GetParentalControlSettings`,
  SET_PARENTAL: `${BASE}parentalcontrol/SetParentalControlSettings`,
  GET_LAN: `${BASE}router/GetLANSettings`,
  SET_LAN: `${BASE}router/SetLANSettings`,
};

class JnapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JnapError';
    this.code = code;
  }
}

/** Minimal local JNAP client (the protocol the Linksys app itself speaks to the router). */
class JnapClient {
  constructor({ host, port, username, password, timeout } = {}) {
    let h = String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    let p = Number(port) || 80;
    const m = /^(.*):(\d+)$/.exec(h);
    if (m) { h = m[1]; p = Number(m[2]); }
    this.host = h;
    this.port = p;
    this.timeout = Number(timeout) > 0 ? Number(timeout) : 10000;
    this.auth = 'Basic ' + Buffer.from(`${username || 'admin'}:${password || ''}`, 'utf8').toString('base64');
  }

  post(action, body) {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.host,
        port: this.port,
        path: '/JNAP/',
        method: 'POST',
        agent: false,
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': data.length,
          'X-JNAP-Action': action,
          'X-JNAP-Authorization': this.auth,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (e) => reject(new JnapError('UNREACHABLE', `Connection to the router failed (${e.code || e.message})`)));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) {
            reject(new JnapError('BAD_RESPONSE', `The router at ${this.host} did not answer with JNAP data (HTTP ${res.statusCode}). Is this the address of the main node?`));
            return;
          }
          resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new JnapError('TIMEOUT', `The router at ${this.host} did not answer within ${this.timeout / 1000}s`)));
      req.on('error', (e) => reject(e instanceof JnapError ? e
        : new JnapError('UNREACHABLE', `Cannot reach the router at ${this.host} (${e.code || e.message})`)));
      req.end(data);
    });
  }

  // The router echoes the Authorization header back inside its error text, so the
  // raw "error" field must never reach the log.
  static check(json, action) {
    const result = json && json.result;
    if (result === 'OK') return;
    if (result === '_ErrorUnauthorized') {
      throw new JnapError('UNAUTHORIZED', 'The router rejected the password. Use the router admin password (not the Wi-Fi password).');
    }
    const name = String(action).replace(BASE, '');
    throw new JnapError(String(result || 'BAD_RESPONSE'), `The router refused ${name} (${result || 'no result'})`);
  }

  async call(action, request = {}) {
    return (await this.send(action, request)).output;
  }

  /** Like call(), but also returns what the router says the change will disturb (for example "DeviceRestart"). */
  async send(action, request = {}) {
    const json = await this.post(action, request);
    JnapClient.check(json, action);
    return { output: json.output || {}, sideEffects: Array.isArray(json.sideEffects) ? json.sideEffects : [] };
  }

  /** Run several actions in one HTTP request. Returns the outputs in order. */
  async transaction(list) {
    const json = await this.post(ACTIONS.TRANSACTION, list.map((i) => ({ action: i.action, request: i.request || {} })));
    if (json && json.result !== 'OK' && Array.isArray(json.responses)) {
      const index = json.responses.findIndex((r) => r && r.result !== 'OK');
      if (index >= 0) JnapClient.check(json.responses[index], list[Math.min(index, list.length - 1)].action);
    }
    JnapClient.check(json, ACTIONS.TRANSACTION);
    const responses = Array.isArray(json.responses) ? json.responses : [];
    return list.map((item, i) => {
      JnapClient.check(responses[i], item.action);
      return responses[i].output || {};
    });
  }
}

module.exports = { JnapClient, JnapError, ACTIONS };
