'use strict';
/*
 * Playback state lives entirely in the AudioPlayer token, so the skill needs
 * no database:
 *
 *   v1|<color>|<startOffsetMs>|<budgetMs>|<seq>
 *
 * startOffsetMs  where in the MP3 this stream item started playing
 * budgetMs       play time left, measured from startOffsetMs; -1 = unlimited
 * seq            increments per enqueued file, keeps tokens unique
 *
 * The budget is play time, not wall-clock time, so pausing does not eat into
 * a timer. When the next file would outlast the budget, it is enqueued at an
 * offset chosen so that it ends exactly when the budget runs out.
 */
const { AUDIO_BASE_URL, FILE_MS, COLORS } = require('./config');

const UNLIMITED = -1;

function makeToken({ color, startOffset = 0, budget = UNLIMITED, seq = 0 }) {
  return ['v1', color, Math.round(startOffset), Math.round(budget), seq].join('|');
}

function parseToken(token) {
  if (typeof token !== 'string') return null;
  const p = token.split('|');
  if (p.length !== 5 || p[0] !== 'v1' || !COLORS.includes(p[1])) return null;
  const [startOffset, budget, seq] = p.slice(2).map(Number);
  if (![startOffset, budget, seq].every(Number.isFinite)) return null;
  return { color: p[1], startOffset, budget, seq };
}

function urlFor(color) {
  return `${AUDIO_BASE_URL}/${color}.mp3`;
}

/** Stream item for a fresh start. budget in ms, or UNLIMITED. */
function firstItem(color, budget = UNLIMITED) {
  // A budget shorter than one file: start late in the file so playback ends
  // exactly when the budget does (the skill cannot stop audio on its own).
  let startOffset = 0;
  if (budget !== UNLIMITED && budget < FILE_MS) startOffset = FILE_MS - budget;
  return { url: urlFor(color), offset: startOffset, token: makeToken({ color, startOffset, budget, seq: 0 }) };
}

/**
 * What to enqueue after the item identified by `token` finishes, or null to
 * let playback end.
 */
function nextItem(token) {
  const t = parseToken(token);
  if (!t) return null;
  let budget = UNLIMITED;
  if (t.budget !== UNLIMITED) {
    budget = t.budget - (FILE_MS - t.startOffset);
    if (budget <= 0) return null;
  }
  const startOffset = budget !== UNLIMITED && budget < FILE_MS ? FILE_MS - budget : 0;
  return {
    url: urlFor(t.color),
    offset: startOffset,
    token: makeToken({ color: t.color, startOffset, budget, seq: t.seq + 1 }),
  };
}

/**
 * Resume `token` at the device-reported `offset`. The budget is carried over
 * net of what was already played. Returns null if the budget is spent.
 */
function resumeItem(token, offset) {
  const t = parseToken(token);
  if (!t) return null;
  const off = Math.max(0, Math.min(Number(offset) || 0, FILE_MS - 1));
  let budget = UNLIMITED;
  if (t.budget !== UNLIMITED) {
    budget = t.budget - Math.max(0, off - t.startOffset);
    if (budget <= 1000) return null;
  }
  return {
    url: urlFor(t.color),
    offset: off,
    token: makeToken({ color: t.color, startOffset: off, budget, seq: t.seq + 1 }),
  };
}

/** ISO-8601 duration from AMAZON.DURATION ("PT30M", "PT8H", "P1D") -> ms. */
function parseDuration(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!m || iso === 'P' || iso === 'PT') return null;
  const [d, h, mi, s] = m.slice(1).map((v) => Number(v || 0));
  const ms = (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
  return ms > 0 ? ms : null;
}

/** "1 hour", "90 minutes" -> "an hour and 30 minutes" style, for speech. */
function speakDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const parts = [];
  if (h) parts.push(h === 1 ? 'an hour' : `${h} hours`);
  if (m) parts.push(m === 1 ? '1 minute' : `${m} minutes`);
  return parts.join(' and ') || 'a minute';
}

module.exports = { UNLIMITED, makeToken, parseToken, urlFor, firstItem, nextItem, resumeItem, parseDuration, speakDuration };
