'use strict';

// A very small stand-in for the parts of Homebridge / HAP-NodeJS the plugin uses,
// so the platform can be exercised without installing Homebridge.

const crypto = require('crypto');
const { EventEmitter } = require('events');

function makeCharacteristic(name) {
  return class Characteristic {
    static get UUID() { return `char-${name}`; }
    constructor() { this.displayName = name; this.value = null; }
    onGet(fn) { this.getter = fn; return this; }
    onSet(fn) { this.setter = fn; return this; }
    updateValue(v) { this.value = v; return this; }
    async get() { return this.getter ? this.getter() : this.value; }
    async set(v) { if (this.setter) await this.setter(v); this.value = v; }
  };
}

const Characteristic = {};
for (const n of ['On', 'Name', 'ConfiguredName', 'Manufacturer', 'Model', 'SerialNumber',
  'OccupancyDetected', 'MotionDetected', 'ContactSensorState']) Characteristic[n] = makeCharacteristic(n);

function makeService(name) {
  return class Service {
    static get UUID() { return `svc-${name}`; }
    constructor(displayName, subtype) {
      this.UUID = `svc-${name}`; this.type = name; this.displayName = displayName; this.subtype = subtype;
      this.characteristics = new Map();
    }
    getCharacteristic(C) {
      if (!this.characteristics.has(C.UUID)) this.characteristics.set(C.UUID, new C());
      return this.characteristics.get(C.UUID);
    }
    setCharacteristic(C, v) { this.getCharacteristic(C).updateValue(v); return this; }
    updateCharacteristic(C, v) { this.getCharacteristic(C).updateValue(v); return this; }
    addOptionalCharacteristic() {}
  };
}

const Service = {};
for (const n of ['AccessoryInformation', 'Switch', 'OccupancySensor', 'MotionSensor', 'ContactSensor']) Service[n] = makeService(n);

class PlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName; this.UUID = UUID; this.context = {};
    this.services = [new Service.AccessoryInformation(displayName)];
  }
  getService(T) { return this.services.find((s) => s.UUID === T.UUID); }
  getServiceById(T, subtype) { return this.services.find((s) => s.UUID === T.UUID && s.subtype === subtype); }
  addService(T, displayName, subtype) { const s = new T(displayName, subtype); this.services.push(s); return s; }
  removeService(s) { this.services = this.services.filter((x) => x !== s); }
}

class HapStatusError extends Error {
  constructor(status) { super(`HAP status ${status}`); this.hapStatus = status; }
}

function makeApi(storagePath) {
  const api = new EventEmitter();
  api.hap = {
    Service, Characteristic, HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    uuid: { generate: (s) => crypto.createHash('sha1').update(s).digest('hex') },
  };
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => storagePath };
  api.registered = [];
  api.registerPlatformAccessories = (p, n, list) => api.registered.push(...list);
  api.unregisterPlatformAccessories = (p, n, list) => { api.registered = api.registered.filter((a) => !list.includes(a)); };
  api.updatePlatformAccessories = () => {};
  return api;
}

function makeLog() {
  const lines = [];
  const log = (...a) => lines.push(['info', a.join(' ')]);
  for (const level of ['info', 'warn', 'error', 'debug']) log[level] = (...a) => lines.push([level, a.join(' ')]);
  log.lines = lines;
  log.text = () => lines.map((l) => `${l[0]}: ${l[1]}`).join('\n');
  return log;
}

module.exports = { makeApi, makeLog, Service, Characteristic, PlatformAccessory };
