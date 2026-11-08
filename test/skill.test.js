'use strict';
// Runs the real handlers through ask-sdk-core with a fake Alexa API client,
// so the monetization service client code path is exercised end to end.
// Run: cd lambda && npm test
process.env.AUDIO_BASE_URL = 'https://cdn.test/noise';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Alexa = require(path.join(__dirname, '../lambda/node_modules/ask-sdk-core'));
const skillMod = require('../lambda/index.js');
const pb = require('../lambda/src/playback.js');
const { FILE_MS, FREE_LIMIT_MS } = require('../lambda/src/config.js');

const HOUR = 3600e3;
const MIN = 60e3;

function buildSkill(product) {
  const apiClient = {
    invoke: async (req) => {
      if (req.url.includes('/inSkillProducts')) {
        if (product === 'fail') return { statusCode: 500, headers: [], body: '{}' };
        return { statusCode: 200, headers: [], body: JSON.stringify({ inSkillProducts: product ? [product] : [], isTruncated: false }) };
      }
      return { statusCode: 404, headers: [], body: '{}' };
    },
  };
  return Alexa.SkillBuilders.custom()
    .addRequestHandlers(...skillMod.handlers)
    .addErrorHandlers(skillMod.ErrorHandler)
    .withApiClient(apiClient)
    .create();
}

const FREE = { productId: 'amzn1.adg.product.x', referenceName: 'premium', entitled: 'NOT_ENTITLED', purchasable: 'PURCHASABLE' };
const PAID = { ...FREE, entitled: 'ENTITLED', purchasable: 'NOT_PURCHASABLE' };

function envelope(request, { audio, session } = {}) {
  return {
    version: '1.0',
    session: { new: false, sessionId: 's', application: { applicationId: 'a' }, user: { userId: 'u' }, attributes: session || {} },
    context: {
      System: { application: { applicationId: 'a' }, user: { userId: 'u' }, device: { deviceId: 'd', supportedInterfaces: { AudioPlayer: {} } },
        apiEndpoint: 'https://api.amazonalexa.com', apiAccessToken: 't' },
      AudioPlayer: audio || { playerActivity: 'IDLE' },
    },
    request: { requestId: 'r', timestamp: new Date().toISOString(), locale: 'en-US', ...request },
  };
}

const intent = (name, slots = {}) => ({
  type: 'IntentRequest',
  intent: {
    name,
    confirmationStatus: 'NONE',
    slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: 'NONE' }])),
  },
});

async function run(product, request, opts) {
  const out = await buildSkill(product).invoke(envelope(request, opts));
  return out.response;
}
const speech = (r) => (r.outputSpeech && r.outputSpeech.ssml) || '';
const playDir = (r) => (r.directives || []).find((d) => d.type === 'AudioPlayer.Play');

// ------------------------------------------------------------- pure logic

test('token round-trips and rejects junk', () => {
  const t = pb.makeToken({ color: 'pink', startOffset: 5, budget: 9, seq: 2 });
  assert.deepEqual(pb.parseToken(t), { color: 'pink', startOffset: 5, budget: 9, seq: 2 });
  for (const bad of [null, '', 'v1|green|0|0|0', 'v2|pink|0|0|0', 'v1|pink|x|0|0', 'v1|pink|0|0']) assert.equal(pb.parseToken(bad), null);
});

test('durations parse from AMAZON.DURATION', () => {
  assert.equal(pb.parseDuration('PT30M'), 30 * MIN);
  assert.equal(pb.parseDuration('PT8H'), 8 * HOUR);
  assert.equal(pb.parseDuration('PT1H30M'), 90 * MIN);
  assert.equal(pb.parseDuration('P1D'), 24 * HOUR);
  for (const bad of [undefined, '', 'P', 'PT', '30 minutes', 'PT0M']) assert.equal(pb.parseDuration(bad), null);
  assert.equal(pb.speakDuration(90 * MIN), 'an hour and 30 minutes');
  assert.equal(pb.speakDuration(2 * HOUR), '2 hours');
});

test('unlimited stream keeps enqueuing from the top', () => {
  let item = pb.firstItem('brown');
  assert.equal(item.offset, 0);
  for (let i = 0; i < 10; i++) {
    item = pb.nextItem(item.token);
    assert.ok(item);
    assert.equal(item.offset, 0);
    assert.equal(item.url, 'https://cdn.test/noise/brown.mp3');
  }
});

test('timer: total play time equals the budget exactly', () => {
  for (const budget of [MIN, 30 * MIN, HOUR, 90 * MIN, 2 * HOUR, 7.5 * HOUR]) {
    let item = pb.firstItem('pink', budget);
    let played = FILE_MS - item.offset;
    let n = 1;
    while ((item = pb.nextItem(item.token))) { played += FILE_MS - item.offset; n++; }
    assert.equal(played, budget, `budget ${budget}`);
    assert.equal(n, Math.ceil(budget / FILE_MS));
  }
});

test('resume carries the remaining budget, net of time played', () => {
  // 90 min budget: first file starts at 0 with 90 min left
  const first = pb.firstItem('white', 90 * MIN);
  const resumed = pb.resumeItem(first.token, 20 * MIN);            // paused 20 min in
  assert.equal(pb.parseToken(resumed.token).budget, 70 * MIN);
  let played = FILE_MS - resumed.offset;                            // 40 min to end of file
  let item = resumed;
  while ((item = pb.nextItem(item.token))) played += FILE_MS - item.offset;
  assert.equal(played, 70 * MIN);
  // spent budget: nothing to resume
  const short = pb.firstItem('white', 10 * MIN);                    // starts at 50 min
  assert.equal(pb.resumeItem(short.token, FILE_MS - 500), null);
  assert.equal(pb.resumeItem('garbage', 0), null);
});

// ------------------------------------------------------------- handlers

test('launch pitches premium only to non-subscribers', async () => {
  assert.match(speech(await run(FREE, { type: 'LaunchRequest' })), /Pink and brown come with Steady Noise Premium/);
  assert.doesNotMatch(speech(await run(PAID, { type: 'LaunchRequest' })), /Premium/);
  assert.doesNotMatch(speech(await run(null, { type: 'LaunchRequest' })), /Premium/);     // ISP not offered
});

test('free user: white noise plays, capped at one hour', async () => {
  const r = await run(FREE, intent('PlayNoiseIntent', { color: 'white' }));
  const d = playDir(r);
  assert.equal(d.playBehavior, 'REPLACE_ALL');
  assert.equal(d.audioItem.stream.url, 'https://cdn.test/noise/white.mp3');
  assert.equal(pb.parseToken(d.audioItem.stream.token).budget, FREE_LIMIT_MS);
  assert.equal(r.shouldEndSession, true);

  const long = await run(FREE, intent('PlayNoiseIntent', { color: 'white', duration: 'PT8H' }));
  assert.match(speech(long), /free version plays for up to an hour/);
  assert.equal(pb.parseToken(playDir(long).audioItem.stream.token).budget, FREE_LIMIT_MS);
});

test('free user: pink/brown triggers the Upsell, carrying the request', async () => {
  const r = await run(FREE, intent('PlayNoiseIntent', { color: 'brown', duration: 'PT2H' }));
  const d = r.directives.find((x) => x.type === 'Connections.SendRequest');
  assert.equal(d.name, 'Upsell');
  assert.equal(d.payload.InSkillProduct.productId, FREE.productId);
  assert.deepEqual(JSON.parse(d.token), { color: 'brown', durationMs: 2 * HOUR });
  assert.equal(playDir(r), undefined);
});

test('ISP lookup failing does not unlock premium, and offers white', async () => {
  const r = await run('fail', intent('PlayNoiseIntent', { color: 'pink' }));
  assert.equal(playDir(r), undefined);
  assert.match(speech(r), /isn't available on this account/);
});

test('subscriber: any color, unlimited or timed', async () => {
  const r = await run(PAID, intent('PlayNoiseIntent', { color: 'brown' }));
  assert.equal(pb.parseToken(playDir(r).audioItem.stream.token).budget, pb.UNLIMITED);
  const t = await run(PAID, intent('PlayNoiseIntent', { color: 'pink', duration: 'PT30M' }));
  const d = playDir(t);
  assert.equal(d.audioItem.stream.offsetInMilliseconds, FILE_MS - 30 * MIN);
  assert.match(speech(t), /pink noise for 30 minutes/);
});

test('upsell accepted plays the color that was asked for', async () => {
  const r = await run(FREE, {
    type: 'Connections.Response', name: 'Upsell', status: { code: '200', message: 'OK' },
    payload: { purchaseResult: 'ACCEPTED', productId: FREE.productId }, token: JSON.stringify({ color: 'brown', durationMs: null }),
  });
  assert.equal(playDir(r).audioItem.stream.url, 'https://cdn.test/noise/brown.mp3');
  assert.equal(pb.parseToken(playDir(r).audioItem.stream.token).budget, pb.UNLIMITED);
});

test('upsell declined offers white, and yes plays it', async () => {
  const r = await run(FREE, {
    type: 'Connections.Response', name: 'Upsell', status: { code: '200', message: 'OK' },
    payload: { purchaseResult: 'DECLINED' }, token: JSON.stringify({ color: 'pink', durationMs: 20 * MIN }),
  });
  assert.match(speech(r), /White noise is free/);
  assert.equal(r.shouldEndSession, false);
  const out = await buildSkill(FREE).invoke(envelope(intent('AMAZON.YesIntent'), { session: { pending: { type: 'play', color: 'white', durationMs: 20 * MIN } } }));
  assert.equal(pb.parseToken(playDir(out.response).audioItem.stream.token).budget, 20 * MIN);
});

test('buy / what can I buy / cancel', async () => {
  const buy = await run(FREE, intent('BuyIntent'));
  assert.equal(buy.directives[0].name, 'Buy');
  assert.match(speech(await run(PAID, intent('BuyIntent'))), /already have/);
  const what = await run(FREE, intent('WhatCanIBuyIntent'));
  assert.match(speech(what), /Want to subscribe/);
  const cancel = await run(PAID, intent('CancelSubscriptionIntent'));
  assert.equal(cancel.directives[0].name, 'Cancel');
});

test('purchase error is handled gracefully', async () => {
  const r = await run(FREE, { type: 'Connections.Response', name: 'Buy', status: { code: '500', message: 'x' }, payload: {}, token: '{}' });
  assert.match(speech(r), /isn't available right now/);
});

test('PlaybackNearlyFinished enqueues with expectedPreviousToken; spent budget stops', async () => {
  const tok = pb.firstItem('pink').token;
  const r = await run(PAID, { type: 'AudioPlayer.PlaybackNearlyFinished', token: tok, offsetInMilliseconds: FILE_MS - 5000 });
  const d = playDir(r);
  assert.equal(d.playBehavior, 'ENQUEUE');
  assert.equal(d.audioItem.stream.expectedPreviousToken, tok);
  assert.equal(r.outputSpeech, undefined);

  const free = pb.firstItem('white', FREE_LIMIT_MS).token;
  const end = await run(FREE, { type: 'AudioPlayer.PlaybackNearlyFinished', token: free, offsetInMilliseconds: FILE_MS - 5000 });
  assert.equal(playDir(end), undefined);
});

test('pause stops; resume continues at the device offset', async () => {
  const p = await run(PAID, intent('AMAZON.PauseIntent'));
  assert.equal(p.directives[0].type, 'AudioPlayer.Stop');
  const tok = pb.firstItem('brown').token;
  const r = await run(PAID, intent('AMAZON.ResumeIntent'), { audio: { token: tok, offsetInMilliseconds: 123456, playerActivity: 'STOPPED' } });
  assert.equal(playDir(r).audioItem.stream.offsetInMilliseconds, 123456);
  const none = await run(PAID, intent('AMAZON.ResumeIntent'));
  assert.match(speech(none), /Nothing to resume/);
});

test('hardware buttons: play resumes, pause stops, no speech', async () => {
  const tok = pb.firstItem('white', HOUR).token;
  const r = await run(FREE, { type: 'PlaybackController.PlayCommandIssued' }, { audio: { token: tok, offsetInMilliseconds: 1000 } });
  assert.ok(playDir(r));
  assert.equal(r.outputSpeech, undefined);
  const s = await run(FREE, { type: 'PlaybackController.PauseCommandIssued' });
  assert.equal(s.directives[0].type, 'AudioPlayer.Stop');
  const n = await run(FREE, { type: 'PlaybackController.NextCommandIssued' });
  assert.equal(n.outputSpeech, undefined);
});

test('every built-in audio intent gets a response', async () => {
  for (const name of ['AMAZON.LoopOnIntent', 'AMAZON.LoopOffIntent', 'AMAZON.ShuffleOnIntent', 'AMAZON.ShuffleOffIntent',
    'AMAZON.NextIntent', 'AMAZON.PreviousIntent', 'AMAZON.RepeatIntent', 'AMAZON.StartOverIntent', 'AMAZON.StopIntent',
    'AMAZON.CancelIntent', 'AMAZON.HelpIntent', 'AMAZON.FallbackIntent', 'AMAZON.NoIntent', 'AMAZON.NavigateHomeIntent']) {
    const r = await run(FREE, intent(name));
    assert.ok(r, name);
  }
  for (const t of ['AudioPlayer.PlaybackStarted', 'AudioPlayer.PlaybackStopped', 'AudioPlayer.PlaybackFinished', 'AudioPlayer.PlaybackFailed', 'SessionEndedRequest']) {
    const r = await run(FREE, { type: t, token: 'x', error: {} });
    assert.equal(r.outputSpeech, undefined, t);
  }
});

test('color slot resolves synonyms via entity resolution', async () => {
  const req = intent('PlayNoiseIntent', { color: 'deep' });
  req.intent.slots.color.resolutions = { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { name: 'brown', id: 'brown' } }] }] };
  const r = await run(PAID, req);
  assert.equal(playDir(r).audioItem.stream.url, 'https://cdn.test/noise/brown.mp3');
  const none = await run(PAID, intent('PlayNoiseIntent'));
  assert.match(speech(none), /Which would you like/);
});

test('interaction model and manifest are consistent', () => {
  const model = require('../skill-package/interactionModels/custom/en-US.json').interactionModel.languageModel;
  const names = model.intents.map((i) => i.name);
  for (const n of ['PlayNoiseIntent', 'BuyIntent', 'WhatCanIBuyIntent', 'CancelSubscriptionIntent', 'AMAZON.PauseIntent', 'AMAZON.ResumeIntent']) assert.ok(names.includes(n), n);
  const play = model.intents.find((i) => i.name === 'PlayNoiseIntent');
  assert.equal(new Set(play.samples.map((s) => s.toLowerCase())).size, play.samples.length, 'duplicate samples');
  const m = require('../skill-package/skill.json').manifest;
  assert.deepEqual(m.apis.custom.interfaces, [{ type: 'AUDIO_PLAYER' }]);
  assert.equal(m.privacyAndCompliance.allowsPurchases, true);
  const isp = require('../skill-package/isps/subscription/premium.json').inSkillProductDefinition;
  assert.equal(isp.referenceName, require('../lambda/src/config.js').PRODUCT_REF);
});
