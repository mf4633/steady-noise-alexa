'use strict';

// Where the MP3s live. Must be HTTPS with a publicly trusted certificate
// (Alexa refuses self-signed). Files: <sound>.mp3 for every id in SOUNDS.
// Set AUDIO_BASE_URL in the Lambda environment, or edit the default here.
const AUDIO_BASE_URL = (process.env.AUDIO_BASE_URL || 'https://steady-noise-audio.steady-noise-audio-worker.workers.dev').replace(/\/+$/, '');

// id -> how it is spoken ("Playing rain") and titled on screens.
const SOUNDS = {
  white: { say: 'white noise', title: 'White noise' },
  pink: { say: 'pink noise', title: 'Pink noise' },
  brown: { say: 'brown noise', title: 'Brown noise' },
  rain: { say: 'rain', title: 'Rain' },
  ocean: { say: 'ocean waves', title: 'Ocean waves' },
  fan: { say: 'fan sounds', title: 'Fan' },
};

module.exports = {
  AUDIO_BASE_URL,
  // Length of each MP3 in ms. Must match audio-build/make_noise.py --seconds.
  FILE_MS: 60 * 60 * 1000,
  SOUNDS,
  // Kept as COLORS: the slot and token field are named "color" from v1.
  COLORS: Object.keys(SOUNDS),
  FREE_COLORS: ['white'],
  // Longest timer we accept; anything longer is treated as "all night".
  MAX_TIMER_MS: 12 * 60 * 60 * 1000,
  // ISP referenceNames in skill-package/isps/subscription/. Either one unlocks Premium.
  PRODUCT_REF: 'premium',
  ANNUAL_REF: 'premium_annual',
  SKILL_NAME: 'Steady Noise',
  PREMIUM_NAME: 'Steady Noise Premium',
};
