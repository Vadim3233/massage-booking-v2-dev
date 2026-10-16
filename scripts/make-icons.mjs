// Local-only: draws the home-screen icons (the round VM mark, a cream ring and ivory letters on deep slate blue) as PNG files.
// Usage: node scripts/make-icons.mjs <output folder>
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const [out = 'icons.local'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })

// Drawn once at 512px and scaled, so every size looks the same. `inset` shrinks the mark for the "maskable" icon,
// whose outer fifth can be cut away by the phone.
const page_html = inset => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; background: #24465e; }
  #icon { width: 512px; height: 512px; display: grid; place-items: center; background: #24465e; transform-origin: 0 0; }
  #mark { width: ${Math.round(320 * inset)}px; height: ${Math.round(320 * inset)}px; box-sizing: border-box; border: ${Math.round(14 * inset)}px solid #f4ede3; border-radius: 50%; display: grid; place-items: center;
    font: 600 ${Math.round(150 * inset)}px/1 'Playfair Display', Georgia, serif; letter-spacing: ${Math.round(4 * inset)}px; color: #faf8f5; padding-left: ${Math.round(4 * inset)}px; }
</style></head><body><div id="icon"><div id="mark">VM</div></div></body></html>`

const browser = await chromium.launch({ channel: 'msedge' })
const jobs = [['icon-512.png', 512, 1], ['icon-192.png', 192, 1], ['apple-touch-icon.png', 180, 1], ['icon-maskable-512.png', 512, 0.78]]
for (const [name, size, inset] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(page_html(inset), { waitUntil: 'networkidle' })
  await page.evaluate(async scale => { await document.fonts.ready; document.getElementById('icon').style.transform = `scale(${scale})` }, size / 512)
  await page.screenshot({ path: `${out}/${name}`, clip: { x: 0, y: 0, width: size, height: size } })
  await page.close()
}
await browser.close()
console.log('Icons drawn in', out)
