# Steady Noise: Alexa skill

White, pink, and brown noise, rain, ocean waves, and a fan on Alexa, with a monthly or yearly Premium subscription.

```
"Alexa, ask Steady Noise for white noise"            -> free, plays up to 1 hour
"Alexa, ask Steady Noise for brown noise"            -> Premium upsell (or plays, if subscribed)
"Alexa, ask Steady Noise for pink noise for 2 hours" -> timed; ends exactly at 2:00 of play
"Alexa, pause" / "Alexa, resume"                     -> timer pauses with the audio
```

| Tier | Colors | Length |
|---|---|---|
| Free | white | all night, or any timer up to 12 h |
| Premium ($1.99/mo or $9.99/yr, 7-day free trial) | all six: white, pink, brown, rain, ocean, fan | all night, or any timer up to 12 h |

## Layout

```
audio-build/make_noise.py      generates docs/audio/{white,pink,brown,rain,ocean,fan}.mp3 (1 h seamless loops, 96 kbps mono, 43 MB each)
lambda/index.js                handlers: play, ISP buy/upsell/cancel, AudioPlayer + PlaybackController events
lambda/src/playback.js         stateless queue/timer logic; all state rides in the AudioPlayer token
lambda/src/config.js           AUDIO_BASE_URL, free-tier limits, product reference name
skill-package/                 manifest, interaction model, isps/subscription/premium.json
docs/                          privacy.html, terms.html, icons (for GitHub Pages)
test/skill.test.js             20 tests; real handlers + fake Alexa API client
scripts/deploy.sh              preflight (audio URLs reachable, tests) + ask deploy
```

## How playback works

There is no database. The token on each stream item is `v1|color|startOffset|budget|seq`.
On `PlaybackNearlyFinished` the skill enqueues the next copy of the hour-long file. If a
timer is running and the next file would outlast it, the file is enqueued at an offset
chosen so that it ends exactly when the timer does. The skill cannot stop audio on its own;
this is how the timer is enforced. Budgets count play time, so pausing doesn't use up a timer.

## Audio

```bash
python audio-build/make_noise.py              # ~2 min; writes docs/audio/*.mp3 (served by GitHub Pages)
```

- white: flat; pink: −3.0 dB/oct; brown: −5.9 dB/oct (measured on the encoded output)
- all three normalized to −20 dBFS RMS, peaks about −5 dBFS
- the loop seam is an equal-power 5 s crossfade into the file's own head; the PCM step at the seam is within the normal sample-to-sample distribution for every color

Alexa needs HTTPS with a publicly trusted certificate. Each listener-hour is about 43 MB of
egress, so the host matters once there are subscribers:

- **Cloudflare R2** (recommended): no egress fees.
- GitHub Pages: works to start (files are < 100 MB), but has a soft 100 GB/month bandwidth limit, about 2,300 listener-hours.
- Alexa-hosted S3: the free tier's transfer cap is small for all-night audio.

## Before the first deploy

1. Upload `audio/*.mp3` and set `AUDIO_BASE_URL` in `lambda/src/config.js`.
2. Publish `docs/` so `https://mf4633.github.io/steady-noise-alexa/{privacy,terms}.html` and the icons resolve (or change the URLs in `skill.json` and `premium.json`).
3. Alexa developer console > **Payments**: finish the tax and payment interview. ISP is blocked until this is done.
4. `bash scripts/deploy.sh`

If `ask deploy` doesn't create the subscription from `skill-package/isps/`, create it by hand. First put your
vendor ID (`~/.ask/cli_config` > profiles.default.vendor_id) in `premium.json`'s `vendorId`, then run
`ask smapi create-isp-for-vendor` and `ask smapi associate-isp-with-skill` (the deploy script prints both).

## Testing

```bash
cd lambda && npm install && npm test
```

The local tests cannot check Alexa's NLU or the real purchase flow. After deploying, use the developer
console's Test tab and a real Echo. Sandbox purchases are free and can be reset with
`ask smapi reset-entitlement-for-product`.

## Certification notes

- Every built-in AudioPlayer intent (Loop, Shuffle, Next, Previous, Repeat, StartOver) is in the model and handled.
- The description makes no health claims (category: Health & Fitness); the terms say it is not a medical device.
- Free content (white noise) works without a purchase, so the skill is usable before anyone subscribes.
