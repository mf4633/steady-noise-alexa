'use strict';
const Alexa = require('ask-sdk-core');
const cfg = require('./src/config');
const pb = require('./src/playback');

const ART = 'https://mf4633.github.io/steady-noise-alexa/icon-512.png';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- helpers

const reqType = (hi) => Alexa.getRequestType(hi.requestEnvelope);
const intentIs = (hi, ...names) =>
  reqType(hi) === 'IntentRequest' && names.includes(Alexa.getIntentName(hi.requestEnvelope));

function slotColor(hi) {
  const slot = Alexa.getSlot(hi.requestEnvelope, 'color');
  if (!slot) return null;
  const res = slot.resolutions && slot.resolutions.resolutionsPerAuthority;
  const match = res && res.find((r) => r.status && r.status.code === 'ER_SUCCESS_MATCH');
  const id = match && match.values[0].value.id;
  if (id && cfg.COLORS.includes(id)) return id;
  const raw = (slot.value || '').toLowerCase();
  return cfg.COLORS.find((c) => raw.includes(c)) || null;
}

function slotDurationMs(hi) {
  const v = Alexa.getSlotValue(hi.requestEnvelope, 'duration');
  const ms = pb.parseDuration(v);
  return ms ? Math.min(ms, cfg.MAX_TIMER_MS) : null;
}

/** The premium product, or null if ISP is unavailable for this user/locale. */
async function getProduct(hi) {
  try {
    const ms = hi.serviceClientFactory.getMonetizationServiceClient();
    const locale = Alexa.getLocale(hi.requestEnvelope);
    const res = await ms.getInSkillProducts(locale);
    return (res.inSkillProducts || []).find((p) => p.referenceName === cfg.PRODUCT_REF) || null;
  } catch (e) {
    console.log('ISP lookup failed:', e && e.message);
    return null;
  }
}
const isEntitled = (p) => !!p && p.entitled === 'ENTITLED';
const isPurchasable = (p) => !!p && p.purchasable === 'PURCHASABLE';

function audioContext(hi) {
  return (hi.requestEnvelope.context && hi.requestEnvelope.context.AudioPlayer) || {};
}

function metadata(color) {
  return {
    title: `${cap(color)} noise`,
    subtitle: cfg.SKILL_NAME,
    art: { sources: [{ url: ART }] },
    backgroundImage: { sources: [{ url: ART }] },
  };
}

function play(rb, item, behavior = 'REPLACE_ALL', expectedPrevious = null) {
  const color = pb.parseToken(item.token).color;
  return rb.addAudioPlayerPlayDirective(behavior, item.url, item.token, item.offset, expectedPrevious, metadata(color));
}

function setPending(hi, pending) {
  hi.attributesManager.setSessionAttributes({ pending });
}

function upsellOrExplain(hi, product, color, durationMs) {
  if (!isPurchasable(product)) {
    setPending(hi, { type: 'play', color: 'white', durationMs });
    return hi.responseBuilder
      .speak(`${cap(color)} noise is part of ${cfg.PREMIUM_NAME}, which isn't available on this account. White noise is free. Want that instead?`)
      .reprompt('Want white noise instead?')
      .getResponse();
  }
  return hi.responseBuilder
    .addDirective({
      type: 'Connections.SendRequest',
      name: 'Upsell',
      payload: {
        InSkillProduct: { productId: product.productId },
        upsellMessage: `${cap(color)} noise comes with ${cfg.PREMIUM_NAME}, which plays white, pink, and brown noise for as long as you like. Want to hear more?`,
      },
      token: JSON.stringify({ color, durationMs: durationMs || null }),
    })
    .getResponse();
}

/** Start a color, enforcing the free tier. */
async function startPlayback(hi, color, durationMs, product) {
  if (product === undefined) product = await getProduct(hi);
  const premium = isEntitled(product);
  if (!premium && !cfg.FREE_COLORS.includes(color)) return upsellOrExplain(hi, product, color, durationMs);

  let budget;
  let speech;
  if (premium) {
    budget = durationMs || pb.UNLIMITED;
    speech = durationMs ? `Playing ${color} noise for ${pb.speakDuration(durationMs)}.` : `Playing ${color} noise.`;
  } else {
    budget = Math.min(durationMs || cfg.FREE_LIMIT_MS, cfg.FREE_LIMIT_MS);
    speech = durationMs && durationMs > cfg.FREE_LIMIT_MS
      ? `The free version plays for up to ${pb.speakDuration(cfg.FREE_LIMIT_MS)}. Playing ${color} noise for ${pb.speakDuration(budget)}.`
      : `Playing ${color} noise for ${pb.speakDuration(budget)}.`;
  }
  return play(hi.responseBuilder.speak(speech), pb.firstItem(color, budget)).withShouldEndSession(true).getResponse();
}

/** Resume whatever the device was last playing, if anything is left. */
function resumeResponse(hi, speech) {
  const ctx = audioContext(hi);
  const item = pb.resumeItem(ctx.token, ctx.offsetInMilliseconds);
  const rb = hi.responseBuilder;
  if (!item) {
    if (reqType(hi).startsWith('PlaybackController.')) return rb.getResponse();
    return rb.speak('Nothing to resume. Say white, pink, or brown noise to start.')
      .reprompt('Which would you like: white, pink, or brown noise?').getResponse();
  }
  if (speech) rb.speak(speech);
  return play(rb, item).withShouldEndSession(true).getResponse();
}

// ---------------------------------------------------------------- intents

const LaunchHandler = {
  canHandle: (hi) => reqType(hi) === 'LaunchRequest',
  async handle(hi) {
    const product = await getProduct(hi);
    const tier = isEntitled(product) || !isPurchasable(product)
      ? ''
      : ` White noise is free. Pink and brown come with ${cfg.PREMIUM_NAME}.`;
    return hi.responseBuilder
      .speak(`Welcome to ${cfg.SKILL_NAME}. Which would you like: white, pink, or brown noise? You can add a time, like brown noise for two hours.${tier}`)
      .reprompt('Say white, pink, or brown noise.')
      .getResponse();
  },
};

const PlayNoiseHandler = {
  canHandle: (hi) => intentIs(hi, 'PlayNoiseIntent'),
  async handle(hi) {
    const color = slotColor(hi);
    if (!color) {
      return hi.responseBuilder.speak('Which would you like: white, pink, or brown noise?')
        .reprompt('Say white, pink, or brown noise.').getResponse();
    }
    return startPlayback(hi, color, slotDurationMs(hi));
  },
};

const YesHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.YesIntent'),
  async handle(hi) {
    const { pending } = hi.attributesManager.getSessionAttributes();
    if (pending && pending.type === 'play') return startPlayback(hi, pending.color, pending.durationMs);
    if (pending && pending.type === 'buy') return BuyHandler.handle(hi);
    return hi.responseBuilder.speak('Say white, pink, or brown noise.').reprompt('Which color?').getResponse();
  },
};

const NoHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.NoIntent'),
  handle: (hi) => hi.responseBuilder.speak('Okay. Goodnight.').withShouldEndSession(true).getResponse(),
};

const BuyHandler = {
  canHandle: (hi) => intentIs(hi, 'BuyIntent'),
  async handle(hi) {
    const product = await getProduct(hi);
    if (isEntitled(product)) {
      return hi.responseBuilder.speak(`You already have ${cfg.PREMIUM_NAME}. Which would you like: white, pink, or brown noise?`)
        .reprompt('Which color?').getResponse();
    }
    if (!isPurchasable(product)) {
      return hi.responseBuilder.speak(`${cfg.PREMIUM_NAME} isn't available on this account. White noise is still free; just say white noise.`)
        .reprompt('Say white noise to start.').getResponse();
    }
    return hi.responseBuilder.addDirective({
      type: 'Connections.SendRequest',
      name: 'Buy',
      payload: { InSkillProduct: { productId: product.productId } },
      token: JSON.stringify({ color: null }),
    }).getResponse();
  },
};

const WhatCanIBuyHandler = {
  canHandle: (hi) => intentIs(hi, 'WhatCanIBuyIntent'),
  async handle(hi) {
    const product = await getProduct(hi);
    if (isEntitled(product)) {
      return hi.responseBuilder.speak(`You have ${cfg.PREMIUM_NAME}: white, pink, and brown noise, for as long as you like. Which would you like?`)
        .reprompt('Which color?').getResponse();
    }
    if (!isPurchasable(product)) {
      return hi.responseBuilder.speak('There is nothing to buy on this account right now. White noise is free.')
        .reprompt('Say white noise to start.').getResponse();
    }
    setPending(hi, { type: 'buy' });
    return hi.responseBuilder
      .speak(`${cfg.PREMIUM_NAME} adds pink and brown noise and removes the one hour limit, so any color can play all night or for a time you choose. Want to subscribe?`)
      .reprompt(`Want to subscribe to ${cfg.PREMIUM_NAME}?`)
      .getResponse();
  },
};

const CancelSubscriptionHandler = {
  canHandle: (hi) => intentIs(hi, 'CancelSubscriptionIntent'),
  async handle(hi) {
    const product = await getProduct(hi);
    if (!product) {
      return hi.responseBuilder.speak('There is no subscription to cancel on this account.').withShouldEndSession(true).getResponse();
    }
    return hi.responseBuilder.addDirective({
      type: 'Connections.SendRequest',
      name: 'Cancel',
      payload: { InSkillProduct: { productId: product.productId } },
      token: JSON.stringify({ color: null }),
    }).getResponse();
  },
};

const PurchaseResponseHandler = {
  canHandle: (hi) => reqType(hi) === 'Connections.Response',
  async handle(hi) {
    const r = hi.requestEnvelope.request;
    let ask = {};
    try { ask = JSON.parse(r.token || '{}') || {}; } catch (e) { ask = {}; }
    const ok = r.status && Number(r.status.code) === 200;
    const result = r.payload && r.payload.purchaseResult;
    const rb = hi.responseBuilder;

    if (!ok || result === 'ERROR') {
      console.log('Connections.Response error', JSON.stringify(r.status), JSON.stringify(r.payload));
      setPending(hi, { type: 'play', color: 'white', durationMs: ask.durationMs || null });
      return rb.speak('Purchasing isn\'t available right now. White noise is still free. Want it?')
        .reprompt('Want white noise?').getResponse();
    }

    if (r.name === 'Cancel') {
      // ACCEPTED here only means the cancel flow ran; the subscription stays
      // active until the end of the paid period.
      setPending(hi, { type: 'play', color: 'white', durationMs: null });
      return rb.speak('Okay. White noise stays free. Want it now?').reprompt('Want white noise?').getResponse();
    }

    if (result === 'ACCEPTED' || result === 'ALREADY_PURCHASED') {
      if (ask.color) return startPlayback(hi, ask.color, ask.durationMs, { entitled: 'ENTITLED' });
      return rb.speak('You\'re all set. Which would you like: white, pink, or brown noise?')
        .reprompt('Which color?').getResponse();
    }

    // DECLINED (or PENDING_PURCHASE): offer the free color.
    setPending(hi, { type: 'play', color: 'white', durationMs: ask.durationMs || null });
    return rb.speak('No problem. White noise is free. Want that instead?').reprompt('Want white noise?').getResponse();
  },
};

const HelpHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.HelpIntent'),
  async handle(hi) {
    const product = await getProduct(hi);
    const tier = isEntitled(product)
      ? ` You have ${cfg.PREMIUM_NAME}, so every color plays until you stop it.`
      : (isPurchasable(product)
        ? ` White noise is free for up to an hour at a time. ${cfg.PREMIUM_NAME} adds pink and brown, with no time limit. Say what can I buy to hear more.`
        : ' White noise is free for up to an hour at a time.');
    return hi.responseBuilder
      .speak(`${cfg.SKILL_NAME} plays steady background noise. Say white, pink, or brown noise, or add a time, like pink noise for 30 minutes. Say stop or pause anytime.${tier} Which would you like?`)
      .reprompt('Say white, pink, or brown noise.')
      .getResponse();
  },
};

const PauseStopHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.PauseIntent', 'AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent'),
  handle: (hi) => hi.responseBuilder.addAudioPlayerStopDirective().withShouldEndSession(true).getResponse(),
};

const ResumeHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.ResumeIntent', 'AMAZON.StartOverIntent', 'AMAZON.RepeatIntent'),
  handle: (hi) => resumeResponse(hi),
};

const UnsupportedAudioHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.LoopOnIntent', 'AMAZON.LoopOffIntent', 'AMAZON.ShuffleOnIntent',
    'AMAZON.ShuffleOffIntent', 'AMAZON.NextIntent', 'AMAZON.PreviousIntent'),
  handle: (hi) => {
    const ctx = audioContext(hi);
    if (pb.parseToken(ctx.token)) {
      return resumeResponse(hi, 'This plays continuously. To switch colors, say: Alexa, ask Steady Noise for pink noise.');
    }
    return hi.responseBuilder.speak('That isn\'t supported here. Say white, pink, or brown noise.')
      .reprompt('Which color?').getResponse();
  },
};

const FallbackHandler = {
  canHandle: (hi) => intentIs(hi, 'AMAZON.FallbackIntent'),
  handle: (hi) => hi.responseBuilder.speak('I can play white, pink, or brown noise. Which would you like?')
    .reprompt('Say white, pink, or brown noise.').getResponse(),
};

// ---------------------------------------------------------------- audio events

const NearlyFinishedHandler = {
  canHandle: (hi) => reqType(hi) === 'AudioPlayer.PlaybackNearlyFinished',
  handle(hi) {
    const token = hi.requestEnvelope.request.token;
    const next = pb.nextItem(token);
    if (!next) return hi.responseBuilder.getResponse();
    return play(hi.responseBuilder, next, 'ENQUEUE', token).getResponse();
  },
};

const AudioEventHandler = {
  canHandle: (hi) => ['AudioPlayer.PlaybackStarted', 'AudioPlayer.PlaybackStopped', 'AudioPlayer.PlaybackFinished']
    .includes(reqType(hi)),
  handle: (hi) => hi.responseBuilder.getResponse(),
};

const PlaybackFailedHandler = {
  canHandle: (hi) => reqType(hi) === 'AudioPlayer.PlaybackFailed',
  handle(hi) {
    console.log('PlaybackFailed', JSON.stringify(hi.requestEnvelope.request.error));
    return hi.responseBuilder.getResponse();
  },
};

const PlaybackControllerHandler = {
  canHandle: (hi) => reqType(hi).startsWith('PlaybackController.'),
  handle(hi) {
    const t = reqType(hi);
    if (t === 'PlaybackController.PlayCommandIssued') return resumeResponse(hi);
    if (t === 'PlaybackController.PauseCommandIssued') return hi.responseBuilder.addAudioPlayerStopDirective().getResponse();
    return hi.responseBuilder.getResponse();
  },
};

const SystemExceptionHandler = {
  canHandle: (hi) => reqType(hi) === 'System.ExceptionEncountered',
  handle(hi) {
    console.log('System.ExceptionEncountered', JSON.stringify(hi.requestEnvelope.request));
    return hi.responseBuilder.getResponse();
  },
};

const SessionEndedHandler = {
  canHandle: (hi) => reqType(hi) === 'SessionEndedRequest',
  handle: (hi) => hi.responseBuilder.getResponse(),
};

const ErrorHandler = {
  canHandle: () => true,
  handle(hi, error) {
    console.log('Error:', error && error.stack);
    const t = reqType(hi);
    if (t.startsWith('AudioPlayer.') || t.startsWith('PlaybackController.')) return hi.responseBuilder.getResponse();
    return hi.responseBuilder.speak('Sorry, something went wrong. Say white, pink, or brown noise to try again.')
      .reprompt('Which color?').getResponse();
  },
};

const handlers = [
  LaunchHandler, PlayNoiseHandler, YesHandler, NoHandler, BuyHandler, WhatCanIBuyHandler,
  CancelSubscriptionHandler, PurchaseResponseHandler, HelpHandler, PauseStopHandler, ResumeHandler,
  UnsupportedAudioHandler, FallbackHandler, NearlyFinishedHandler, AudioEventHandler, PlaybackFailedHandler,
  PlaybackControllerHandler, SystemExceptionHandler, SessionEndedHandler,
];

exports.handlers = handlers;
exports.ErrorHandler = ErrorHandler;
exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(...handlers)
  .addErrorHandlers(ErrorHandler)
  .withApiClient(new Alexa.DefaultApiClient())
  .lambda();
