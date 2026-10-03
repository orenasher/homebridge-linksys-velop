'use strict';

const { classify, cloneWeek, isValidWeek } = require('./schedule');

const DEFAULT_DESCRIPTION = 'default description'; // what the Linksys app writes

/** Normalise a MAC address to AA:BB:CC:DD:EE:FF, or return null if it is not one. */
function normMac(value) {
  const hex = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

function ruleMacs(rule) {
  return (Array.isArray(rule && rule.macAddresses) ? rule.macAddresses : []).map(normMac).filter(Boolean);
}

function findRule(settings, mac) {
  const rules = Array.isArray(settings && settings.rules) ? settings.rules : [];
  return rules.find((r) => ruleMacs(r).includes(mac)) || null;
}

/**
 * What the router is currently doing for a group of MAC addresses.
 * state: 'disabled' (parental controls switched off globally), 'paused' (every MAC blocked),
 *        'open' (nothing blocked), 'scheduled' or 'mixed'.
 */
function deviceView(settings, macs) {
  const perMac = macs.map((mac) => {
    const rule = findRule(settings, mac);
    if (!rule || rule.isEnabled === false) return { mac, kind: 'open', week: null };
    const kind = classify(rule.wanSchedule);
    return { mac, kind, week: kind === 'unknown' ? null : rule.wanSchedule };
  });
  const scheduled = perMac.find((m) => m.kind === 'scheduled');
  const view = { perMac, scheduledWeek: scheduled ? cloneWeek(scheduled.week) : null };
  if (!settings || settings.isParentalControlEnabled === false) return { ...view, state: 'disabled' };
  if (perMac.length && perMac.every((m) => m.kind === 'paused')) return { ...view, state: 'paused' };
  if (perMac.every((m) => m.kind === 'open')) return { ...view, state: 'open' };
  return { ...view, state: scheduled ? 'scheduled' : 'mixed' };
}

/**
 * Return the payload for SetParentalControlSettings with `week` applied to every MAC in `macs`.
 * Rules belonging to other devices are passed through untouched.
 */
function applyWeek(settings, macs, week) {
  if (!isValidWeek(week)) throw new Error('Refusing to write an invalid schedule');
  const rules = JSON.parse(JSON.stringify(Array.isArray(settings && settings.rules) ? settings.rules : []));
  const group = new Set(macs);
  const needRule = [];

  for (const mac of macs) {
    const rule = rules.find((r) => ruleMacs(r).includes(mac));
    if (!rule) {
      needRule.push(mac);
    } else if (ruleMacs(rule).every((m) => group.has(m))) {
      rule.wanSchedule = cloneWeek(week);
      rule.isEnabled = true;
    } else {
      // The rule is shared with a device we do not manage: split our MAC out of it.
      rule.macAddresses = rule.macAddresses.filter((m) => normMac(m) !== mac);
      needRule.push(mac);
    }
  }
  for (const mac of needRule) {
    rules.push({
      isEnabled: true,
      description: DEFAULT_DESCRIPTION,
      macAddresses: [mac],
      wanSchedule: cloneWeek(week),
      blockedURLs: [],
    });
  }

  const max = Number(settings && settings.maxRules);
  if (max > 0 && rules.length > max) {
    throw new Error(`The router allows at most ${max} parental-control rules; remove a device in the Linksys app first`);
  }

  const blocking = classify(week) !== 'open';
  const enabled = blocking ? true : !(settings && settings.isParentalControlEnabled === false);
  return { isParentalControlEnabled: enabled, rules };
}

module.exports = { DEFAULT_DESCRIPTION, normMac, ruleMacs, findRule, deviceView, applyWeek };
