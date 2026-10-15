import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkVerdict,
  chooseToKeep,
  countCopyRows,
  humanSize,
  isInside,
  parseDbUrl,
  redact,
  stamp,
  stampToDate,
  suspiciousDrops,
  verifyDump,
} from './backup-lib.mjs'

describe('backup folder names', () => {
  it('writes the PC-local time and reads it back', () => {
    const when = new Date(2026, 9, 15, 21, 30)
    expect(stamp(when)).toBe('2026-10-15_2130')
    expect(stampToDate('2026-10-15_2130')).toEqual(when)
  })

  it('pads single digits', () => {
    expect(stamp(new Date(2027, 0, 5, 7, 4))).toBe('2027-01-05_0704')
  })

  it('does not read names it did not make', () => {
    expect(stampToDate('backup.log')).toBeNull()
    expect(stampToDate('.partial-2026-10-15_2130')).toBeNull()
  })
})

describe('parseDbUrl', () => {
  const good = 'postgresql://postgres.abcdefgh:s3cretpass@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'

  it('accepts the session pooler address and reports what it is', () => {
    expect(parseDbUrl(good)).toMatchObject({ host: 'aws-0-eu-west-1.pooler.supabase.com', user: 'postgres.abcdefgh', password: 's3cretpass', pooler: true, direct: false })
  })

  it('recognises the direct address (which needs IPv6)', () => {
    expect(parseDbUrl('postgresql://postgres:pw12345@db.abcdefgh.supabase.co:5432/postgres')).toMatchObject({ direct: true, pooler: false })
  })

  it('tells the owner the placeholder is still there, without printing the address', () => {
    expect(() => parseDbUrl('postgresql://postgres.abc:[YOUR-PASSWORD]@host.example:5432/postgres')).toThrow(/placeholder/)
  })

  it.each([
    ['', /empty/],
    ['   ', /empty/],
    ['not an address', /not a valid address/],
    ['https://example.com/', /postgresql/],
    ['postgresql://postgres.abc@host.example:5432/postgres', /no password/],
  ])('rejects %j in plain words', (value, message) => {
    expect(() => parseDbUrl(value)).toThrow(message)
  })

  it('never puts the password in an error', () => {
    for (const bad of ['postgresql://u:pw-secret-123@/postgres', 'https://u:pw-secret-123@example.com/']) {
      try {
        parseDbUrl(bad)
      } catch (error) {
        expect(error.message).not.toContain('pw-secret-123')
      }
    }
  })
})

describe('redact', () => {
  it('hides a given secret and the password inside any postgres address', () => {
    const text = 'failed for postgresql://postgres.abc:topsecret@host.example:5432/postgres and also topsecret again'
    const clean = redact(text, ['topsecret'])
    expect(clean).not.toContain('topsecret')
    expect(clean).toContain('postgresql://postgres.abc:***@host.example')
  })

  it('leaves ordinary text alone', () => {
    expect(redact('all fine')).toBe('all fine')
  })
})

const DATA = [
  'SET statement_timeout = 0;',
  'COPY "public"."clients" ("id", "first_name") FROM stdin;',
  '1\tAda',
  '2\tGrace',
  '\\.',
  'COPY "public"."bookings" ("id") FROM stdin;',
  '\\.',
  'COPY "auth"."users" ("id", "email") FROM stdin;',
  'u1\ta@example.test',
  '\\.',
  '',
].join('\n')

describe('countCopyRows', () => {
  it('counts the rows of each table, including empty ones', () => {
    expect(countCopyRows(DATA)).toEqual({ 'public.clients': 2, 'public.bookings': 0, 'auth.users': 1 })
  })

  it('copes with Windows line endings', () => {
    expect(countCopyRows(DATA.replaceAll('\n', '\r\n'))).toEqual({ 'public.clients': 2, 'public.bookings': 0, 'auth.users': 1 })
  })

  it('does not mistake a data row that looks like a COPY line for a new table', () => {
    const sneaky = ['COPY "public"."notes" ("body") FROM stdin;', 'COPY "public"."clients" ("id") FROM stdin;', '\\.'].join('\n')
    expect(countCopyRows(sneaky)).toEqual({ 'public.notes': 1 })
  })
})

describe('verifyDump', () => {
  const schema = 'CREATE TABLE IF NOT EXISTS "public"."clients" (\n"id" uuid\n);'

  it('accepts a dump that has the structure and the main tables', () => {
    const { problems, rows } = verifyDump({ schemaSql: schema, dataSql: DATA })
    expect(problems).toEqual([])
    expect(rows['public.clients']).toBe(2)
  })

  it('names what is missing', () => {
    const { problems } = verifyDump({ schemaSql: '', dataSql: 'COPY "public"."clients" ("id") FROM stdin;\n\\.\n' })
    expect(problems).toEqual([
      'The structure file has no clients table, so it looks empty or wrong.',
      'The data file has nothing for public.bookings.',
      'The data file has nothing for auth.users.',
    ])
  })
})

describe('suspiciousDrops', () => {
  it('warns when a watched table loses more than half its rows', () => {
    expect(suspiciousDrops({ 'public.clients': 40, 'public.bookings': 100 }, { 'public.clients': 40, 'public.bookings': 3 })).toEqual([
      'public.bookings went from 100 rows to 3 since the last backup.',
    ])
  })

  it('stays quiet for small tables, normal growth and tables it does not watch', () => {
    expect(suspiciousDrops({ 'public.clients': 4, 'public.event_outbox': 500 }, { 'public.clients': 0, 'public.event_outbox': 1 })).toEqual([])
    expect(suspiciousDrops({ 'public.clients': 40 }, { 'public.clients': 41 })).toEqual([])
    expect(suspiciousDrops(null, { 'public.clients': 1 })).toEqual([])
  })
})

describe('chooseToKeep', () => {
  const days = (from, count) => Array.from({ length: count }, (_, i) => stamp(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, 21, 30)))

  it('keeps everything while there are few', () => {
    const names = days(new Date(2026, 9, 1), 10)
    expect(chooseToKeep(names).remove).toEqual([])
  })

  it('keeps the newest 30, then the newest of each earlier month', () => {
    const names = days(new Date(2026, 5, 1), 140) // 1 June to 17 October
    const { keep, remove } = chooseToKeep(names, { recent: 30, monthly: 6 })
    expect(keep.slice(0, 30)).toEqual(names.slice(-30).reverse())
    // September's newest days are already among the 30, so its extra copy is the 18th; the other months keep their last day.
    expect(keep.slice(30)).toEqual(['2026-09-18_2130', '2026-08-31_2130', '2026-07-31_2130', '2026-06-30_2130'])
    expect(keep.length + remove.length).toBe(140)
  })

  it('never lists a file or folder it did not make for removal', () => {
    const names = ['backup.log', 'notes.txt', '.partial-2026-10-15_2130', ...days(new Date(2026, 0, 1), 40)]
    const { remove, keep } = chooseToKeep(names, { recent: 5, monthly: 0 })
    expect([...keep, ...remove]).not.toContain('backup.log')
    expect([...keep, ...remove]).not.toContain('notes.txt')
    expect([...keep, ...remove]).not.toContain('.partial-2026-10-15_2130')
    expect(keep).toHaveLength(5)
  })
})

describe('checkVerdict', () => {
  const now = new Date(2026, 9, 16, 9, 0)

  it('is fine for a backup from last night', () => {
    expect(checkVerdict(['2026-10-15_2130'], now)).toMatchObject({ ok: true, message: expect.stringContaining('2026-10-15 at 21:30') })
  })

  it('complains when the newest good backup is older than the limit', () => {
    const verdict = checkVerdict(['2026-10-01_2130', '2026-10-09_2130'], now, 3)
    expect(verdict.ok).toBe(false)
    expect(verdict.latest).toBe('2026-10-09_2130')
    expect(verdict.message).toContain('6 days ago')
  })

  it('complains when there is none', () => {
    expect(checkVerdict([], now)).toMatchObject({ ok: false, latest: null })
    expect(checkVerdict(['backup.log'], now).ok).toBe(false)
  })
})

describe('isInside', () => {
  const root = path.resolve('project')

  it('spots a folder inside the project, the project itself, and folders outside it', () => {
    expect(isInside(path.join(root, 'backups'), root)).toBe(true)
    expect(isInside(root, root)).toBe(true)
    expect(isInside(path.resolve('somewhere-else'), root)).toBe(false)
    expect(isInside(path.resolve('project-backups'), root)).toBe(false)
  })
})

describe('humanSize', () => {
  it('uses sizes a person can read', () => {
    expect(humanSize(900)).toBe('900 bytes')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
