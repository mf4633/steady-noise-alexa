'use strict';

// Where the three MP3s live. Must be HTTPS with a publicly trusted certificate
// (Alexa refuses self-signed). Files: white.mp3, pink.mp3, brown.mp3.
// Set AUDIO_BASE_URL in the Lambda environment, or edit the default here.
const AUDIO_BASE_URL = (process.env.AUDIO_BASE_URL || 'https://mf4633.github.io/steady-noise-alexa/audio').replace(/\/+$/, '');

module.exports = {
  AUDIO_BASE_URL,
  // Length of each MP3 in ms. Must match audio-build/make_noise.py --seconds.
  FILE_MS: 60 * 60 * 1000,
  COLORS: ['white', 'pink', 'brown'],
  FREE_COLORS: ['white'],
  // Free tier plays for up to this long per request.
  FREE_LIMIT_MS: 60 * 60 * 1000,
  // Longest timer we accept; anything longer is treated as "all night".
  MAX_TIMER_MS: 12 * 60 * 60 * 1000,
  // ISP referenceName in skill-package/isps/subscription/premium.json.
  PRODUCT_REF: 'premium',
  SKILL_NAME: 'Steady Noise',
  PREMIUM_NAME: 'Steady Noise Premium',
};
