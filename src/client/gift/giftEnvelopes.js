// The envelope the gift opens from (/gift/<code>): Vadim's own pictures (20 Nov 2026), one per colour family, saved in
// public/gift-envelope-*.webp. Each voucher design opens from the envelope that suits it, and the whole gift page (envelope, Surprise and
// the voucher) takes that envelope's paper colour (gift.css .gift-open--<name>, colours in index.css), so it feels like one present.
export const ENVELOPES = {
  ivory: { name: 'ivory', src: '/gift-envelope-ivory.webp', w: 1200, h: 800 },
  blush: { name: 'blush', src: '/gift-envelope-blush.webp', w: 1200, h: 1279 },
  sage: { name: 'sage', src: '/gift-envelope-sage.webp', w: 1200, h: 800 },
}

const BY_DESIGN = {
  navy_gold: 'ivory', gold_foil: 'ivory', black_gold: 'ivory', birthday_navy: 'ivory', new_baby: 'ivory',
  any_occasion: 'blush', birthday_pink: 'blush', anniversary: 'blush',
  christmas_night: 'sage', wrapped_present: 'sage', for_him: 'sage',
}

export const envelopeFor = design => ENVELOPES[BY_DESIGN[design] || 'ivory']
