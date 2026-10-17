import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The colours live in one place, src/index.css. These tests keep two promises about them: text and interface colours stay readable (WCAG AA), and
// the style files use the tokens instead of colour values of their own.
const here = fileURLToPath(new URL('.', import.meta.url))
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '')
const index = withoutComments(readFileSync(join(here, 'index.css'), 'utf8'))
const root = index.slice(index.indexOf(':root'), index.indexOf('}', index.indexOf(':root')))
const tokens = Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))

const channels = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
const linear = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const luminance = hex => { const [r, g, b] = channels(hex); return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) }
const contrast = (a, b) => { const x = luminance(tokens[a]); const y = luminance(tokens[b]); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

const GROUNDS = ['--paper', '--surface', '--cream', '--primary-soft']
const TEXT = [
  // The three text colours on every ground the app puts text on.
  ...['--ink', '--ink-soft', '--muted'].flatMap(text => GROUNDS.map(ground => [text, ground])),
  ['--ink', '--cancel-surface'], ['--ink-soft', '--cancel-surface'], ['--muted', '--cancel-surface'],
  // White on the brand colour and on what it turns into when pressed, on the alert badge and on the destructive button.
  ['--on-primary', '--primary'], ['--on-primary', '--primary-strong'], ['--on-primary', '--alert-dot'], ['--on-primary', '--danger'],
  // The brand colour as text and as an icon: links, outline buttons, the selected tab.
  ...GROUNDS.map(ground => ['--primary', ground]), ['--primary-strong', '--primary-soft'],
  // Each status: its words on its own background, and on the page and white, where a bare label can sit.
  ['--ok-ink', '--ok-bg'], ['--needs-ink', '--needs-bg'], ['--done-ink', '--done-bg'], ['--cancel-ink', '--cancel-bg'], ['--noshow-ink', '--noshow-bg'],
  ['--danger', '--danger-soft'], ['--accent-ink', '--accent-soft'],
  ...['--ok-ink', '--needs-ink', '--wait-ink', '--cancel-ink', '--noshow-ink', '--danger', '--accent-ink'].flatMap(text => ['--paper', '--surface'].map(ground => [text, ground])),
  ['--cancel-ink', '--cancel-surface'], ['--cancel-ink', '--cream'], ['--ok-ink', '--cream'], ['--needs-ink', '--cream'], ['--done-ink', '--primary-soft'],
  // The tints the Day view and the cards sit on: a card that needs the Admin, a block of time, travel, free time, a pressed pale button, the alert badge.
  ['--ink', '--needs-tint'], ['--ink-soft', '--needs-tint'], ['--muted', '--needs-tint'], ['--needs-ink', '--needs-tint'],
  ['--block-ink', '--block-bg'], ['--ink-soft', '--buffer-bg'], ['--ok-ink', '--free-bg'], ['--primary', '--primary-line'], ['--ink', '--needs-badge'],
  ['--on-primary', '--ink'], ['--ink-soft', '--hairline'],
]
const INTERFACE = [
  // The edge of a field, and of anything tapped that has no other outline, must be seen (3:1); so must the coloured edge of a card.
  ...['--paper', '--surface', '--cream'].map(ground => ['--control-border', ground]),
  ...['--ok-rail', '--needs-rail', '--wait-rail', '--cancel-rail', '--noshow-rail', '--danger-line'].map(rail => [rail, '--surface']),
  ['--primary', '--paper'],
]

describe('the colour tokens', () => {
  it('are all plain hex colours or shadows, with the ones the checks below rely on present', () => {
    for (const name of new Set([...TEXT, ...INTERFACE].flat())) expect(tokens[name], name).toMatch(/^#[0-9a-f]{6}$/)
  })

  it.each(TEXT)('%s reads on %s (text, 4.5:1)', (text, ground) => {
    expect(contrast(text, ground), `${text} ${tokens[text]} on ${ground} ${tokens[ground]}`).toBeGreaterThanOrEqual(4.5)
  })

  it.each(INTERFACE)('%s stands out against %s (interface part, 3:1)', (part, ground) => {
    expect(contrast(part, ground), `${part} ${tokens[part]} on ${ground} ${tokens[ground]}`).toBeGreaterThanOrEqual(3)
  })
})

describe('the style files', () => {
  const styleFiles = dir => readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return styleFiles(path)
    return path.endsWith('.css') && !path.endsWith(`${join('src', 'index.css')}`) ? [path] : []
  })
  const files = styleFiles(here)

  it('are found', () => { expect(files.length).toBeGreaterThan(5) })

  it('use the colour tokens, with no colour values of their own', () => {
    const own = []
    for (const file of files) {
      withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, number) => {
        for (const match of line.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|color-mix)\(/g)) own.push(`${file.slice(here.length)}:${number + 1} ${match[0]}`)
      })
    }
    expect(own).toEqual([])
  })
})
