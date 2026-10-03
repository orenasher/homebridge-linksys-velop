#!/usr/bin/env node
'use strict';

// Small command-line tool to check the router connection without Homebridge.
//   node cli.js <router-ip> status
//   node cli.js <router-ip> pause  <MAC>
//   node cli.js <router-ip> resume <MAC> [22:00 06:00]
// The admin password is asked for (or taken from LINKSYS_PASSWORD) and never printed.

const readline = require('readline');
const { JnapClient, ACTIONS } = require('./lib/jnap');
const { normMac, ruleMacs, deviceView, applyWeek } = require('./lib/parental');
const { pausedWeek, openWeek, nightlyWeek, describe } = require('./lib/schedule');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const [host, command = 'status', macArg, start, end] = process.argv.slice(2);
  if (!host || !['status', 'pause', 'resume'].includes(command)) {
    console.log('Usage:\n  node cli.js <router-ip> status\n  node cli.js <router-ip> pause <MAC>\n  node cli.js <router-ip> resume <MAC> [22:00 06:00]');
    process.exit(1);
  }
  const password = process.env.LINKSYS_PASSWORD || await askHidden('Router admin password: ');
  const client = new JnapClient({ host, password });

  const [settings, list] = await client.transaction([{ action: ACTIONS.GET_PARENTAL }, { action: ACTIONS.GET_DEVICES }]);
  const info = new Map();
  for (const d of list.devices || []) {
    const user = (d.properties || []).find((p) => p.name === 'userDeviceName');
    for (const i of d.knownInterfaces || []) {
      info.set(normMac(i.macAddress), { name: (user && user.value) || d.friendlyName || '?', online: (d.connections || []).length > 0 });
    }
  }
  const show = (s) => {
    console.log(`Parental Controls: ${s.isParentalControlEnabled === false ? 'OFF' : 'on'}   rules: ${(s.rules || []).length}/${s.maxRules || '?'}`);
    for (const rule of s.rules || []) {
      for (const mac of ruleMacs(rule)) {
        const i = info.get(mac) || { name: '?', online: false };
        const view = deviceView(s, [mac]);
        const state = view.state === 'scheduled' ? describe(view.scheduledWeek) : view.state;
        console.log(`  ${mac}  ${i.online ? 'online ' : 'offline'}  ${state.padEnd(22)} ${i.name}`);
      }
    }
  };

  if (command === 'status') {
    console.log(`Router answered. ${(list.devices || []).length} devices known.`);
    show(settings);
    return;
  }

  const mac = normMac(macArg);
  if (!mac) throw new Error('Give the MAC address of the device, e.g. AA:BB:CC:DD:EE:FF');
  const week = command === 'pause' ? pausedWeek() : (start && end ? nightlyWeek(start, end) : openWeek());
  const next = applyWeek(settings, [mac], week);
  await client.call(ACTIONS.SET_PARENTAL, next);
  const after = await client.call(ACTIONS.GET_PARENTAL);
  console.log(`${command === 'pause' ? 'Paused' : 'Resumed'} ${mac}. The router now reports:`);
  show(after);
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
