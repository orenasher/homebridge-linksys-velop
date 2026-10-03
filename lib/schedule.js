'use strict';

// Linksys stores a parental-control schedule as 7 strings (one per day) of 48
// characters. Each character is one half-hour slot starting at 00:00:
// '1' = internet allowed, '0' = internet blocked.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SLOTS = 48;
const OPEN_DAY = '1'.repeat(SLOTS);
const BLOCKED_DAY = '0'.repeat(SLOTS);

function weekOf(day) {
  const week = {};
  for (const d of DAYS) week[d] = day;
  return week;
}

const openWeek = () => weekOf(OPEN_DAY);
const pausedWeek = () => weekOf(BLOCKED_DAY);

function isValidWeek(week) {
  return !!week && typeof week === 'object'
    && DAYS.every((d) => typeof week[d] === 'string' && /^[01]{48}$/.test(week[d]));
}

/** @returns {'open'|'paused'|'scheduled'|'unknown'} */
function classify(week) {
  if (!isValidWeek(week)) return 'unknown';
  if (DAYS.every((d) => week[d] === OPEN_DAY)) return 'open';
  if (DAYS.every((d) => week[d] === BLOCKED_DAY)) return 'paused';
  return 'scheduled';
}

function equalWeeks(a, b) {
  return isValidWeek(a) && isValidWeek(b) && DAYS.every((d) => a[d] === b[d]);
}

function cloneWeek(week) {
  const out = {};
  for (const d of DAYS) out[d] = week[d];
  return out;
}

/** "22:00" -> 44, "06:30" -> 13, "24:00" -> 48 */
function parseTime(text) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(text));
  if (!m) throw new Error(`Invalid time "${text}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || (h === 24 && min !== 0) || (min !== 0 && min !== 30)) {
    throw new Error(`Invalid time "${text}" (use whole or half hours, e.g. 22:00 or 22:30)`);
  }
  return h * 2 + (min === 30 ? 1 : 0);
}

/** A schedule that blocks the internet every day between two times (may cross midnight). */
function nightlyWeek(pauseStart, pauseEnd) {
  const s = parseTime(pauseStart) % SLOTS;
  const e = parseTime(pauseEnd) % SLOTS;
  if (s === e) throw new Error('Pause start and end times must be different');
  const slots = new Array(SLOTS).fill('1');
  for (let i = s; i !== e; i = (i + 1) % SLOTS) slots[i] = '0';
  return weekOf(slots.join(''));
}

function slotLabel(i) {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  return `${h}:${i % 2 ? '30' : '00'}`;
}

/** Short human description for the log. */
function describe(week) {
  const kind = classify(week);
  if (kind !== 'scheduled') return kind;
  const same = DAYS.every((d) => week[d] === week.sunday);
  const day = week.sunday;
  const starts = [];
  for (let i = 0; i < SLOTS; i++) {
    const prev = day[(i + SLOTS - 1) % SLOTS];
    if (day[i] === '0' && prev === '1') {
      let j = i;
      while (day[j % SLOTS] === '0' && j < i + SLOTS) j++;
      starts.push(`${slotLabel(i)}-${slotLabel(j % SLOTS)}`);
    }
  }
  const text = starts.length ? `blocked ${starts.join(', ')}` : 'custom';
  return same ? text : `${text} (varies by day)`;
}

module.exports = {
  DAYS, SLOTS, OPEN_DAY, BLOCKED_DAY,
  openWeek, pausedWeek, isValidWeek, classify, equalWeeks, cloneWeek,
  parseTime, nightlyWeek, describe,
};
