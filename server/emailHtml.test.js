import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUTTON_LABEL, EMAIL_COLOURS, EMAIL_TAGLINE, composeEmailHtml, escapeHtml } from './emailHtml.js'

const LINK = 'https://booking.example.com/account?booking=b1&x=1#key=abc123'
const BODY = 'Thank you. Your appointment is confirmed for Mon 19 Oct at 15:00 (60 minutes) at 12 Edith Road, London, SW1A 1AA.\nReference: VDM-20261016-EXAMPLE\n\nI have received your payment.\n\nSee or change your booking: {link}\n\nWarm wishes,\nVad'
const make = (overrides = {}) => composeEmailHtml({ title: 'Your appointment is confirmed', body: BODY, url: LINK, canReply: true, ...overrides })
const at = (html, text) => { const index = html.indexOf(text); expect(index, `"${text}" is in the email`).toBeGreaterThan(-1); return index }

describe('the HTML version of a client email', () => {
  it('carries the words of the message in their order, with the title as the heading and its last word emphasised', () => {
    const html = make()
    expect(html).toMatch(/<h1 [^>]*>Your appointment is <em style="font-style:italic;color:#345b73">confirmed<\/em><\/h1>/)
    // What is on the page, in order (the page's own title and the hidden preview line are not part of it).
    const page = html.replace(/<head>[\s\S]*<\/head>/, '').replace(/<div style="display:none[^>]*>[^<]*<\/div>/, '')
    const order = ['VadMassage', 'Your appointment is', 'Thank you.', 'I have received your payment.', BUTTON_LABEL, 'Warm wishes,', 'Just reply to this email'].map((text) => at(page, text))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html).toContain('<title>Your appointment is confirmed</title>')
  })

  it('sets the day and time in bold, the reference small and apart, and keeps the lines of the signature', () => {
    const html = make()
    expect(html).toContain('<strong>Mon 19 Oct at 15:00</strong>')
    expect(html).toMatch(/<p style="[^"]*font-size:14px[^"]*">Reference: VDM-20261016-EXAMPLE<\/p>/)
    expect(html).toContain('Warm wishes,<br>Vad')
  })

  it('puts the private link on a button and nowhere in the text, and never shows the placeholder', () => {
    const html = make()
    expect(html).toContain(`href="https://booking.example.com/account?booking=b1&amp;x=1#key=abc123"`)
    expect(html).toContain(`>${BUTTON_LABEL}</a>`)
    expect(html.match(/account\?booking/g)).toHaveLength(1)
    expect(html).not.toContain('{link}')
  })

  it('has no button, and no trace of the placeholder, when there is no link to give', () => {
    for (const url of ['', undefined]) {
      const html = make({ url })
      expect(html).not.toContain('<a ')
      expect(html).not.toContain(BUTTON_LABEL)
      expect(html).not.toContain('{link}')
      expect(html).toContain('Warm wishes,<br>Vad')
    }
  })

  it('does not lose a line because a client typed "{link}" into their address', () => {
    const html = make({ body: 'Your appointment is confirmed at 12 {link} Road, London.\n\nSee or change your booking: {link}' })
    expect(html).toContain('Your appointment is confirmed at 12 {link} Road, London.')
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it('has no button for a message that has no line for one', () => {
    expect(make({ body: 'A receipt.\nTotal paid: £85.00' })).not.toContain('<a ')
  })

  it('only ever puts a web address behind the button', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/x', 'https://example.com/a" onclick="x', '/account?booking=b1', 'https://exa mple.com']) {
      expect(make({ url }), url).not.toContain('<a ')
    }
    expect(make({ url: 'http://localhost:5174/account?booking=b1#key=abc' })).toContain('href="http://localhost:5174/account?booking=b1#key=abc"')
  })

  it('escapes everything that came from a client or the database', () => {
    const rude = '<script>alert(1)</script> & "quoted" \'single\' <img src=x onerror=y>'
    const html = make({ title: `Hi ${rude}`, body: `Hello ${rude}.\nReference: ${rude}\n\nSee or change your booking: {link}` })
    expect(html).not.toMatch(/<script|<img|onerror=y>/)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml('a&b<c>"d\'')).toBe('a&amp;b&lt;c&gt;&quot;d&#39;')
  })

  it('invites a reply only when a reply will reach Vad, and always says what to do if it landed in spam', () => {
    const replying = make({ canReply: true })
    const silent = make({ canReply: false })
    expect(replying).toContain('Just reply to this email if you have any questions.')
    expect(silent).not.toContain('Just reply')
    for (const html of [replying, silent]) {
      expect(html).toContain('If it landed in your spam folder, please press “Not spam” so my messages reach you.')
      expect(html).toContain(`VadMassage · ${EMAIL_TAGLINE}`)
    }
  })

  it('gives the mail app a short preview of the first sentence, not of the reference or the link', () => {
    const preview = make().match(/opacity:0">([^<]*)</)[1]
    expect(preview).toBe('Thank you. Your appointment is confirmed for Mon 19 Oct at 15:00 (60 minutes) at 12 Edith Road, London, SW1A 1AA.'.slice(0, 110))
    expect(make({ body: 'Reference: X\n\nSee or change your booking: {link}' }).match(/opacity:0">([^<]*)</)[1]).toBe('')
  })

  it("leaves a title plain when it does not end in a word, as a receipt's does", () => {
    const html = make({ title: 'Your receipt from VadMassage (VM-2026-0001)' })
    expect(html).toMatch(/<h1 [^>]*>Your receipt from VadMassage \(VM-2026-0001\)<\/h1>/)
  })

  it('copes with a title of one word, an empty title and an empty message', () => {
    expect(make({ title: 'Hello' })).toContain('<em style="font-style:italic;color:#345b73">Hello</em>')
    expect(() => make({ title: '', body: '' })).not.toThrow()
    expect(() => make({ title: undefined, body: undefined, url: undefined })).not.toThrow()
  })

  it('is a whole page that needs nothing from anywhere else', () => {
    const html = make()
    expect(html).toMatch(/^<!doctype html>\n<html lang="en-GB">/)
    expect(html).not.toMatch(/<img|<script|<link|<style|@import|url\(|<iframe|<form/i)
    // The one web address in it is the button's.
    expect(html.match(/https?:\/\//g)).toHaveLength(1)
    expect(make({ url: '' }).match(/https?:\/\//g)).toBeNull()
  })
})

describe('the colours of the email', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))?.[1]?.toLowerCase()
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

  it("are the site's own, so an email looks like the booking pages", () => {
    const tokens = { page: 'paper', card: 'surface', hairline: 'hairline', ink: 'ink', inkSoft: 'ink-soft', muted: 'muted', primary: 'primary', onPrimary: 'on-primary' }
    for (const [key, name] of Object.entries(tokens)) expect(EMAIL_COLOURS[key], `${key} is --${name}`).toBe(token(name))
  })

  it('are readable: every pair of text and background is at least 4.5:1', () => {
    const { card, ink, inkSoft, muted, primary, onPrimary } = EMAIL_COLOURS
    for (const [text, background, what] of [[ink, card, 'text'], [inkSoft, card, 'reference'], [muted, card, 'footer'], [primary, card, 'emphasised word'], [onPrimary, primary, 'button']]) {
      expect(contrast(text, background), what).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('are the only colours the page uses', () => {
    const allowed = new Set(Object.values(EMAIL_COLOURS))
    for (const colour of make().match(/#[0-9a-fA-F]{3,8}\b/g)) expect(allowed.has(colour.toLowerCase()), colour).toBe(true)
    expect(make()).not.toMatch(/rgba?\(|hsla?\(/i)
  })
})
