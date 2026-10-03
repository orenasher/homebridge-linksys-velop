'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Small JSON file inside the Homebridge storage folder. It remembers each
 * device's pause schedule (the router forgets it while a device is paused),
 * and it is part of a normal Homebridge backup.
 */
class Store {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.data = { version: 1, devices: {} };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed.devices === 'object' && parsed.devices) this.data = { version: 1, devices: parsed.devices };
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.warn(`Could not read ${this.file}: ${e.message}`);
    }
    this.saved = JSON.stringify(this.data);
    return this;
  }

  entry(id) {
    if (!this.data.devices[id]) this.data.devices[id] = { scheduleEnabled: false };
    return this.data.devices[id];
  }

  save() {
    const text = JSON.stringify(this.data, null, 2);
    if (JSON.stringify(this.data) === this.saved) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.file);
      this.saved = JSON.stringify(this.data);
    } catch (e) {
      this.log.warn(`Could not save ${this.file}: ${e.message}`);
    }
  }
}

module.exports = { Store };
