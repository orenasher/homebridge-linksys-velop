'use strict';

const path = require('path');
const { JnapClient, ACTIONS } = require('./jnap');
const { Store } = require('./store');
const { normMac, ruleMacs, deviceView, applyWeek } = require('./parental');
const {
  openWeek, pausedWeek, nightlyWeek, windowWeek, combineWeeks, classify, equalWeeks, describe,
} = require('./schedule');

const PLUGIN_NAME = 'homebridge-linksys-velop';
const PLATFORM_NAME = 'LinksysVelop';
const REBOOT_ID = 'router-restart';

const DEFAULT_LABELS = { pause: 'Pause', schedule: 'Schedule', connected: 'Connected', restart: 'Restart Router' };

/** HomeKit names may only contain letters, digits, spaces and apostrophes. */
function cleanName(text, fallback) {
  const out = String(text || '')
    .replace(/[^\p{L}\p{N} ']/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ ']+|[ ']+$/g, '');
  return out || fallback;
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

class LinksysVelopPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;

    this.cached = new Map(); // UUID -> accessory restored from the Homebridge cache
    this.devices = new Map(); // id -> runtime device
    this.byMac = new Map(); // MAC -> entry of the router's device list
    this.settings = null; // last parental-control settings read from the router
    this.pending = []; // changes waiting to be written
    this.flushChain = Promise.resolve();
    this.writeSeq = 0;
    this.firstPollDone = false;
    this.reachable = null;
    this.stopped = false;

    if (!this.config.host || !this.config.password) {
      this.log.warn('Not configured yet: set the router address and admin password in the plugin settings.');
      this.disabled = true;
      return;
    }

    const c = this.config;
    this.pollMs = Math.min(3600, Math.max(5, Number(c.pollInterval) || 15)) * 1000;
    this.offlineDelayMs = Math.max(0, Number(c.offlineDelay) || 0) * 1000;
    this.batchMs = 250;
    this.setWaitMs = 5000;
    this.pauseMode = c.pauseSwitchMode === 'internet' ? 'internet' : 'pause';
    this.sensorType = ['occupancy', 'motion', 'contact'].includes(c.presenceSensorType) ? c.presenceSensorType : 'occupancy';
    this.labels = { ...DEFAULT_LABELS };
    for (const [key, value] of Object.entries(c.labels && typeof c.labels === 'object' ? c.labels : {})) {
      if (key in DEFAULT_LABELS && typeof value === 'string' && value.trim()) this.labels[key] = value.trim();
    }
    this.syncAppFlags = boolOr(c.syncAppFlags, true);
    this.excluded = new Set((Array.isArray(c.exclude) ? c.exclude : []).map(normMac).filter(Boolean));

    try {
      this.defaultWeek = nightlyWeek(c.defaultPauseStart || '22:00', c.defaultPauseEnd || '06:00');
    } catch (e) {
      this.log.warn(`Default schedule ignored: ${e.message}. Using 22:00-06:00.`);
      this.defaultWeek = nightlyWeek('22:00', '06:00');
    }

    this.client = new JnapClient({
      host: c.host, port: c.port, username: c.username, password: c.password,
      timeout: (Number(c.timeout) || 10) * 1000,
    });
    this.store = new Store(path.join(api.user.storagePath(), 'linksys-velop.json'), log).load();

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  // Called by Homebridge for every accessory it restored from its cache.
  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  start() {
    this.log.info(`Connecting to the Linksys router at ${this.client.host}`);
    this.setupReboot();
    // Wire up everything we already know about before the router answers, so a
    // switch flipped right after a restart is never silently ignored.
    for (const w of this.wanted(null)) {
      const known = this.cached.has(this.hap.uuid.generate(`${PLUGIN_NAME}:device:${w.id}`));
      if (known || w.cfg.name) this.addDevice(w); // the rest wait until the router tells us their names
    }
    this.loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.flushTimer);
    clearTimeout(this.rebootTimer);
  }

  // ---------------------------------------------------------------- polling

  async loop() {
    if (this.stopped) return;
    try {
      await this.poll();
      if (this.reachable === false) this.log.info('The router is reachable again.');
      this.reachable = true;
    } catch (e) {
      if (this.reachable !== false) this.log.warn(`${e.message} - will keep retrying.`);
      else this.log.debug(e.message);
      this.reachable = false;
      if (e.code === 'UNAUTHORIZED') { this.schedulePoll(Math.max(this.pollMs, 5 * 60 * 1000)); return; }
    }
    this.schedulePoll(this.pollMs);
  }

  schedulePoll(ms) {
    if (this.stopped) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.loop(), ms);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  async fetchAll() {
    const action = this.legacyDevices ? ACTIONS.GET_DEVICES_LEGACY : ACTIONS.GET_DEVICES;
    try {
      const [settings, list] = await this.client.transaction([{ action: ACTIONS.GET_PARENTAL }, { action }]);
      return { settings, list };
    } catch (e) {
      if (e.code === '_ErrorUnknownAction' && !this.legacyDevices) {
        this.legacyDevices = true; // older firmware without GetDevices3
        return this.fetchAll();
      }
      throw e;
    }
  }

  async poll() {
    const seq = this.writeSeq;
    const { settings, list } = await this.fetchAll();
    if (this.writing || seq !== this.writeSeq) return; // a change was written while we were reading
    this.indexDevices(list);
    this.settings = settings;
    this.reconcile();
    for (const dev of this.devices.values()) {
      this.observe(dev, settings, true);
      this.refresh(dev);
    }
    this.store.save();
  }

  indexDevices(list) {
    const byMac = new Map();
    for (const d of Array.isArray(list && list.devices) ? list.devices : []) {
      const online = Array.isArray(d.connections) && d.connections.length > 0;
      const macs = new Set();
      for (const i of d.knownInterfaces || []) macs.add(normMac(i.macAddress));
      for (const cn of d.connections || []) macs.add(normMac(cn.macAddress));
      for (const mac of macs) {
        if (!mac) continue;
        const prev = byMac.get(mac);
        if (!prev || (online && !prev.online)) byMac.set(mac, { device: d, online });
      }
    }
    this.byMac = byMac;
  }

  // ------------------------------------------------------ device discovery

  /**
   * The devices that should exist: the ones listed in the settings, plus every device
   * that has a parental-control rule on the router. Before the router has answered
   * (settings === null) the auto-discovered ones come from the accessory cache.
   */
  wanted(settings) {
    const list = [];
    const claimed = new Set();

    for (const cfg of Array.isArray(this.config.devices) ? this.config.devices : []) {
      const raw = Array.isArray(cfg && cfg.macs) ? cfg.macs : [cfg && cfg.mac];
      const macs = [...new Set(raw.map(normMac).filter(Boolean))].filter((m) => !claimed.has(m));
      if (!macs.length) {
        const blank = !cfg || (!cfg.name && !raw.some(Boolean));
        if (!settings && !blank) this.log.warn(`Device "${cfg.name || '?'}" in the settings has no valid MAC address - skipped.`);
        continue;
      }
      macs.forEach((m) => claimed.add(m));
      list.push({ id: macs[0], macs, cfg, auto: false });
    }
    if (!boolOr(this.config.autoDiscover, true)) return list;

    const groups = settings
      ? (Array.isArray(settings.rules) ? settings.rules : []).map(ruleMacs)
      : [...this.cached.values()].filter((a) => a.context && a.context.auto && Array.isArray(a.context.macs))
        .map((a) => a.context.macs.map(normMac).filter(Boolean));
    for (const group of groups) {
      const macs = group.filter((m) => !claimed.has(m) && !this.excluded.has(m));
      if (!macs.length) continue;
      macs.forEach((m) => claimed.add(m));
      list.push({ id: macs[0], macs, cfg: {}, auto: true });
    }
    return list;
  }

  addDevice(w) {
    const dev = { ...w, paused: null, online: null, lastSeen: 0 };
    this.devices.set(dev.id, dev);
    this.setupDevice(dev);
    return dev;
  }

  /** Bring the accessories in line with the settings and the router. */
  reconcile() {
    const wanted = this.wanted(this.settings);
    for (const w of wanted) {
      const dev = this.devices.get(w.id);
      if (!dev) {
        this.addDevice(w);
      } else if (dev.macs.join() !== w.macs.join()) {
        dev.macs = w.macs;
        dev.accessory.context.macs = w.macs;
      }
    }
    if (this.firstPollDone) return;
    this.firstPollDone = true;

    // Drop what is left over from an earlier configuration, or was removed in the Linksys app.
    const ids = new Set(wanted.map((w) => w.id));
    for (const id of [...this.devices.keys()]) if (!ids.has(id)) this.devices.delete(id);
    const keep = new Set([...this.devices.values()].map((d) => d.accessory.UUID));
    if (this.rebootAccessory) keep.add(this.rebootAccessory.UUID);
    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => { this.cached.delete(a.UUID); this.log.info(`Removed "${a.displayName}"`); });
    }
    this.log.info(`Router connected. Managing ${this.devices.size} device(s).`);
  }

  routerName(dev) {
    const entries = dev.macs.map((m) => this.byMac.get(m)).filter(Boolean).map((e) => e.device);
    for (const d of entries) {
      const p = (d.properties || []).find((x) => x.name === 'userDeviceName' && x.value);
      if (p) return p.value;
    }
    for (const d of entries) if (d.friendlyName) return d.friendlyName;
    return null;
  }

  feature(dev, key, globalKey) {
    return boolOr(dev.cfg[key], boolOr(this.config[globalKey], true));
  }

  setupDevice(dev) {
    const { Service, Characteristic } = this.hap;
    const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:device:${dev.id}`);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    const name = cleanName(dev.cfg.name || (accessory && accessory.displayName) || this.routerName(dev), `Device ${dev.id.slice(-8).replace(/:/g, '')}`);
    if (isNew) accessory = new this.api.platformAccessory(name, uuid);
    dev.accessory = accessory;
    dev.name = name;
    accessory.context.id = dev.id;
    accessory.context.macs = dev.macs;
    accessory.context.auto = dev.auto;

    const info = accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Linksys')
      .setCharacteristic(Characteristic.Model, 'Velop client')
      .setCharacteristic(Characteristic.SerialNumber, dev.id);
    if (!isNew && accessory.displayName !== name) {
      // Renamed in the plugin settings.
      if (typeof accessory.updateDisplayName === 'function') accessory.updateDisplayName(name);
      else accessory.displayName = name;
      info.setCharacteristic(Characteristic.Name, name);
    }

    const pause = this.ensureService(accessory, Service.Switch, 'pause', `${name} ${this.labels.pause}`,
      this.feature(dev, 'pauseSwitch', 'pauseSwitches'));
    if (pause) {
      pause.getCharacteristic(Characteristic.On)
        .onGet(() => this.pauseValue(dev))
        .onSet((v) => this.change(dev, 'pause', this.pauseMode === 'internet' ? !v : !!v));
    }

    // Either the single Schedule switch (the schedule comes from the router), or one
    // switch for every schedule defined for this device in the settings.
    const named = this.namedSchedules(dev);
    const wantSwitches = this.feature(dev, 'scheduleSwitch', 'scheduleSwitches');
    dev.scheduleSwitches = wantSwitches;
    const schedule = this.ensureService(accessory, Service.Switch, 'schedule', `${name} ${this.labels.schedule}`,
      wantSwitches && !named.length);
    if (schedule) {
      schedule.getCharacteristic(Characteristic.On)
        .onGet(() => !!this.store.entry(dev.id).scheduleEnabled)
        .onSet((v) => this.change(dev, 'schedule', !!v));
    }
    const namedServices = new Map();
    for (const item of named) {
      const svc = this.ensureService(accessory, Service.Switch, `schedule:${item.id}`, `${name} ${item.label}`, wantSwitches);
      if (!svc) continue;
      namedServices.set(item.id, svc);
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.scheduleOn(dev, item.id))
        .onSet((v) => this.change(dev, 'named', { id: item.id, on: !!v }));
    }
    for (const svc of [...accessory.services]) {
      const sub = svc.subtype;
      if (typeof sub === 'string' && sub.startsWith('schedule:') && !namedServices.has(sub.slice(9))) {
        accessory.removeService(svc);
        if (accessory.context.names) delete accessory.context.names[sub];
      }
    }
    if (named.length) {
      const entry = this.store.entry(dev.id);
      const flags = {};
      for (const item of named) flags[item.id] = !entry.schedules || entry.schedules[item.id] !== false;
      entry.schedules = flags;
    }

    const types = { occupancy: Service.OccupancySensor, motion: Service.MotionSensor, contact: Service.ContactSensor };
    for (const [type, Type] of Object.entries(types)) {
      const wantedHere = type === this.sensorType && this.feature(dev, 'presenceSensor', 'presenceSensors');
      const svc = this.ensureService(accessory, Type, 'presence', `${name} ${this.labels.connected}`, wantedHere);
      if (svc) svc.getCharacteristic(this.presenceCharacteristic()).onGet(() => this.presenceValue(dev));
    }
    dev.services = { pause, schedule, named: namedServices };

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
      this.log.info(`Added "${name}" (${dev.macs.join(', ')})`);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  ensureService(accessory, Type, subtype, displayName, enabled) {
    const { Characteristic } = this.hap;
    const names = accessory.context.names || (accessory.context.names = {});
    let svc = accessory.getServiceById(Type, subtype);
    if (!enabled) {
      if (svc) accessory.removeService(svc);
      // Sensor types share one subtype, so only forget the name when no service uses it any more.
      if (!accessory.services.some((x) => x.subtype === subtype)) delete names[subtype];
      return null;
    }
    const setNames = () => {
      if (!Characteristic.ConfiguredName) return;
      // Gives each tile its own name in the Home app.
      svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      svc.setCharacteristic(Characteristic.ConfiguredName, displayName);
    };
    if (!svc) {
      svc = accessory.addService(Type, displayName, subtype);
      setNames();
    } else if (names[subtype] && names[subtype] !== displayName) {
      // The name was changed in the plugin settings. A name changed in the Home app is left alone otherwise.
      svc.displayName = displayName;
      svc.setCharacteristic(Characteristic.Name, displayName);
      setNames();
    }
    names[subtype] = displayName;
    return svc;
  }

  /** The schedules defined for this device in the settings (empty = use the schedule found on the router). */
  namedSchedules(dev) {
    if (dev.named) return dev.named;
    const list = [];
    const used = new Set();
    const rows = Array.isArray(dev.cfg.schedules) ? dev.cfg.schedules : [];
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object' || (!row.start && !row.end)) return;
      const label = cleanName(row.name, `${this.labels.schedule} ${i + 1}`);
      try {
        const week = windowWeek(row.start, row.end, row.days);
        let id = String(row.id || row.name || i + 1).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || String(i + 1);
        while (used.has(id)) id += '-2';
        used.add(id);
        list.push({ id, label, week });
      } catch (e) {
        this.log.warn(`${dev.name || dev.id}: schedule "${label}" ignored - ${e.message}`);
      }
    });
    dev.named = list;
    return list;
  }

  scheduleOn(dev, id) {
    if (!dev.scheduleSwitches) return true; // no switches: the schedules always apply
    const flags = this.store.entry(dev.id).schedules;
    return !flags || flags[id] !== false;
  }

  /** What the router should enforce for a device with its own schedules: every schedule that is switched on. */
  namedWeek(dev) {
    return combineWeeks(this.namedSchedules(dev).filter((item) => this.scheduleOn(dev, item.id)).map((item) => item.week));
  }

  // ------------------------------------------------------------ HomeKit state

  pauseValue(dev) {
    const paused = dev.paused === true;
    return this.pauseMode === 'internet' ? !paused : paused;
  }

  presenceCharacteristic() {
    const { Characteristic } = this.hap;
    if (this.sensorType === 'motion') return Characteristic.MotionDetected;
    if (this.sensorType === 'contact') return Characteristic.ContactSensorState;
    return Characteristic.OccupancyDetected;
  }

  presenceValue(dev) {
    const on = dev.online === true;
    if (this.sensorType === 'motion') return on;
    if (this.sensorType === 'contact') return on ? 0 : 1; // connected = contact detected (closed)
    return on ? 1 : 0;
  }

  /** Push the current state of a device to HomeKit. */
  refresh(dev) {
    const { Characteristic } = this.hap;
    const now = Date.now();
    const connected = dev.macs.some((m) => { const e = this.byMac.get(m); return e && e.online; });
    if (connected) dev.lastSeen = now;
    const online = connected || (this.offlineDelayMs > 0 && now - dev.lastSeen < this.offlineDelayMs);
    if (dev.online !== null && dev.online !== online) this.log.debug(`${dev.name}: ${online ? 'connected' : 'disconnected'}`);
    dev.online = online;

    const { pause, schedule, named } = dev.services;
    if (pause) pause.updateCharacteristic(Characteristic.On, this.pauseValue(dev));
    if (schedule) schedule.updateCharacteristic(Characteristic.On, !!this.store.entry(dev.id).scheduleEnabled);
    for (const [id, svc] of named) svc.updateCharacteristic(Characteristic.On, this.scheduleOn(dev, id));
    const presence = dev.accessory.services.find((s) => s.subtype === 'presence');
    if (presence) presence.updateCharacteristic(this.presenceCharacteristic(), this.presenceValue(dev));
  }

  // ------------------------------------------------------- parental control

  overrideWeek(dev) {
    const { pauseStart, pauseEnd } = dev.cfg;
    if (!pauseStart && !pauseEnd) return null;
    if (dev.override === undefined) {
      try {
        dev.override = nightlyWeek(pauseStart, pauseEnd);
      } catch (e) {
        this.log.warn(`${dev.name}: schedule in the settings ignored - ${e.message}`);
        dev.override = null;
      }
    }
    return dev.override;
  }

  /** The schedule this device follows whenever its Schedule switch is on. */
  scheduleFor(dev) {
    const entry = this.store.entry(dev.id);
    const fixed = this.overrideWeek(dev);
    if (fixed) return fixed;
    if (classify(entry.schedule) !== 'scheduled') entry.schedule = this.defaultWeek;
    return entry.schedule;
  }

  /**
   * Learn the device's state from what the router reports (it may have been changed in the Linksys app).
   * `enforce`: for a device with its own schedules, put them back if the router has something else.
   */
  observe(dev, settings, enforce = false) {
    const entry = this.store.entry(dev.id);
    const view = deviceView(settings, dev.macs);
    const before = dev.paused;
    const named = this.namedSchedules(dev).length > 0;

    dev.paused = view.state === 'paused';
    if (before !== null && before !== dev.paused) this.log.info(`${dev.name}: ${dev.paused ? 'paused' : 'resumed'} (changed on the router)`);
    if (dev.paused || view.state === 'disabled') return;

    if (named) {
      const expected = this.namedWeek(dev);
      const matches = view.perMac.every((m) => equalWeeks(m.week || openWeek(), expected));
      if (matches) {
        dev.syncTries = 0;
      } else if (enforce) {
        dev.syncTries = (dev.syncTries || 0) + 1;
        if (dev.syncTries <= 2) {
          this.change(dev, 'sync').catch(() => {});
        } else if (dev.syncTries === 3) {
          this.log.warn(`${dev.name}: the router keeps a different schedule than the one set in the plugin settings.`);
        }
      }
      return;
    }

    if (view.scheduledWeek) {
      if (!this.overrideWeek(dev) && !equalWeeks(entry.schedule, view.scheduledWeek)) {
        entry.schedule = view.scheduledWeek;
        this.log.info(`${dev.name}: schedule saved (${describe(entry.schedule)})`);
      }
      entry.scheduleEnabled = true;
    } else if (view.state === 'open') {
      entry.scheduleEnabled = false;
    }
  }

  /** What a device goes back to when its pause ends. */
  resumeWeek(dev) {
    if (this.namedSchedules(dev).length) return this.namedWeek(dev);
    return this.store.entry(dev.id).scheduleEnabled ? this.scheduleFor(dev) : openWeek();
  }

  /** A switch was flipped in HomeKit. Changes arriving together (a scene) are written in one go. */
  change(dev, op, value) {
    const written = new Promise((resolve, reject) => {
      this.pending.push({ dev, op, value, resolve, reject });
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushChain = this.flushChain.then(() => this.flush());
      }, this.batchMs);
    });
    // HomeKit gives up on a slow accessory. If the router takes long to apply the change,
    // answer HomeKit and let the next refresh show the real outcome.
    let timer;
    const patience = new Promise((resolve) => { timer = setTimeout(resolve, this.setWaitMs); });
    written.catch(() => {});
    return Promise.race([written, patience]).finally(() => clearTimeout(timer));
  }

  async flush() {
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    this.writeSeq++;
    this.writing = true;
    try {
      // Always start from what the router has right now, so nothing set in the Linksys app is lost.
      let settings = await this.client.call(ACTIONS.GET_PARENTAL);
      for (const dev of this.devices.values()) this.observe(dev, settings);
      const original = JSON.stringify({ e: settings.isParentalControlEnabled, r: settings.rules });
      const wasEnabled = settings.isParentalControlEnabled !== false;
      const touched = new Map();

      for (const { dev, op, value } of batch) {
        const entry = this.store.entry(dev.id);
        let target = null;
        if (op === 'pause') {
          dev.paused = value;
          target = value ? pausedWeek() : this.resumeWeek(dev);
        } else if (op === 'schedule') {
          entry.scheduleEnabled = value;
          if (!dev.paused) target = value ? this.scheduleFor(dev) : openWeek();
        } else if (op === 'named') {
          entry.schedules = { ...(entry.schedules || {}), [value.id]: value.on };
          dev.syncTries = 0;
          if (!dev.paused) target = this.namedWeek(dev);
        } else if (op === 'sync') {
          if (!dev.paused) target = this.namedWeek(dev);
        }
        if (!target) continue;
        const next = applyWeek(settings, dev.macs, target);
        settings = { ...settings, ...next };
        touched.set(dev.id, { dev, target });
      }

      if (JSON.stringify({ e: settings.isParentalControlEnabled, r: settings.rules }) !== original) {
        await this.client.call(ACTIONS.SET_PARENTAL, {
          isParentalControlEnabled: settings.isParentalControlEnabled,
          rules: settings.rules,
        });
        if (!wasEnabled && settings.isParentalControlEnabled) this.log.warn('Parental Controls were switched off on the router - switched them on.');
      }
      this.settings = settings;
      this.store.save();
      for (const { dev, target } of touched.values()) this.log.info(`${dev.name}: ${describe(target)}`);
      for (const dev of this.devices.values()) this.refresh(dev);
      batch.forEach((b) => b.resolve());
      if (this.syncAppFlags) await this.syncFlags([...touched.values()]);
    } catch (e) {
      this.log.error(`Change failed: ${e.message}`);
      const { HapStatusError, HAPStatus } = this.hap;
      batch.forEach((b) => b.reject(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
    } finally {
      this.writing = false;
      this.writeSeq++;
      this.schedulePoll(2000); // confirm against the router shortly after
    }
  }

  /**
   * The Linksys app labels devices using two properties on the device record
   * ("showInPCList" and "blockAllManually"). Keep them in step so the app shows
   * the same thing as Apple Home. Purely cosmetic: failures are ignored.
   */
  async syncFlags(items) {
    for (const { dev, target } of items) {
      const kind = classify(target);
      for (const mac of dev.macs) {
        const entry = this.byMac.get(mac);
        const deviceID = entry && entry.device && entry.device.deviceID;
        if (!deviceID) continue;
        const props = new Map((entry.device.properties || []).map((p) => [p.name, p.value]));
        const modify = [];
        const remove = [];
        if (kind !== 'open' && props.get('showInPCList') !== 'true') modify.push({ name: 'showInPCList', value: 'true' });
        if (kind === 'paused' && props.get('blockAllManually') !== 'true') modify.push({ name: 'blockAllManually', value: 'true' });
        if (kind !== 'paused' && props.has('blockAllManually')) remove.push('blockAllManually');
        try {
          if (modify.length) await this.client.call(ACTIONS.SET_DEVICE_PROPERTIES, { deviceID, propertiesToModify: modify });
          if (remove.length) await this.client.call(ACTIONS.SET_DEVICE_PROPERTIES, { deviceID, propertiesToRemove: remove });
          // Keep our copy current so the next change does not have to wait for a poll.
          const names = new Set([...modify.map((m) => m.name), ...remove]);
          entry.device.properties = (entry.device.properties || []).filter((x) => !names.has(x.name)).concat(modify);
        } catch (e) {
          this.log.debug(`${dev.name}: could not update the Linksys app labels (${e.message})`);
        }
      }
    }
  }

  // ------------------------------------------------------------------ reboot

  setupReboot() {
    const { Service, Characteristic } = this.hap;
    const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:${REBOOT_ID}`);
    let accessory = this.cached.get(uuid);
    if (!boolOr(this.config.rebootSwitch, false)) return; // a leftover accessory is removed after the first poll

    const name = cleanName(this.labels.restart, DEFAULT_LABELS.restart);
    const isNew = !accessory;
    if (isNew) accessory = new this.api.platformAccessory(name, uuid);
    this.rebootAccessory = accessory;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Linksys')
      .setCharacteristic(Characteristic.Model, 'Velop')
      .setCharacteristic(Characteristic.SerialNumber, REBOOT_ID);
    const svc = this.ensureService(accessory, Service.Switch, 'restart', name, true);
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (v) => {
        if (!v) return;
        clearTimeout(this.rebootTimer);
        this.rebootTimer = setTimeout(() => svc.updateCharacteristic(Characteristic.On, false), 2000);
        try {
          await this.client.call(ACTIONS.REBOOT, {});
          this.log.warn('Restart command sent. The network will be down for a few minutes.');
        } catch (e) {
          this.log.error(`Restart failed: ${e.message}`);
          throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
    }
  }
}

module.exports = { LinksysVelopPlatform, PLUGIN_NAME, PLATFORM_NAME, cleanName };
