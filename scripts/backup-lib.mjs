// Pure helpers for scripts/backup-database.mjs. Nothing here touches files, the network or the clock,
// so every rule (what counts as a good backup, which old copies to keep) can be tested on its own.
import path from 'node:path'

const STAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/
const DAY = 86_400_000
const pad = n => String(n).padStart(2, '0')

/** 2026-10-15_2130: the name of one backup folder, in the PC's own time. */
export function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** The time a backup folder name stands for, or null for any name this tool did not make. */
export function stampToDate(name) {
  const m = STAMP.exec(name)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : null
}

export const isBackupName = name => STAMP.test(name)

/**
 * Checks the connection string the owner saved, without ever echoing it back.
 * Returns what the tool needs to know about it; throws a plain-words Error otherwise.
 */
export function parseDbUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('The connection string is empty.')
  if (/\[YOUR-PASSWORD\]|\[PASSWORD\]|<password>/i.test(text)) {
    throw new Error('The connection string still has the [YOUR-PASSWORD] placeholder. Put the real database password in its place.')
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('The connection string is not a valid address. It should start with postgresql://')
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('The connection string should start with postgresql://')
  if (!url.hostname) throw new Error('The connection string has no server name in it.')
  if (!url.password) throw new Error('The connection string has no password in it.')
  return {
    host: url.hostname,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    pooler: /\.pooler\.supabase\.com$/i.test(url.hostname),
    direct: /^db\.[a-z0-9]+\.supabase\.co$/i.test(url.hostname),
  }
}

/** Hides every secret (and the password part of any postgres address) so logs and messages never show one. */
export function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) if (secret) out = out.split(secret).join('***')
  return out.replace(/(postgres(?:ql)?:\/\/[^:\s/@]*:)[^@\s]*@/gi, '$1***@')
}

/**
 * Counts the rows of every table in a data dump made with `--use-copy`:
 * each table is a `COPY "schema"."table" (...) FROM stdin;` line, one line per row, and a closing `\.`.
 */
export function countCopyRows(sql) {
  const rows = {}
  let current = null
  for (const raw of String(sql ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (current === null) {
      const m = /^COPY\s+(\S+?)\s*(?:\(|FROM\b)/i.exec(line)
      if (m && /FROM stdin;\s*$/i.test(line)) {
        current = m[1].replace(/"/g, '')
        rows[current] = 0
      }
    } else if (line === '\\.') {
      current = null
    } else {
      rows[current] += 1
    }
  }
  return rows
}

/** The tables whose rows only ever grow in normal use, so a sudden drop is worth a warning. */
export const WATCHED_TABLES = ['public.clients', 'public.bookings', 'public.booking_payments', 'public.booking_receipts', 'public.client_addresses']

/** Plain-words problems with a finished dump. An empty list means it looks right. */
export function verifyDump({ schemaSql, dataSql }) {
  const problems = []
  const rows = countCopyRows(dataSql)
  if (!/CREATE TABLE (IF NOT EXISTS )?"?public"?\."?clients"?/i.test(String(schemaSql ?? ''))) {
    problems.push('The structure file has no clients table, so it looks empty or wrong.')
  }
  for (const table of ['public.clients', 'public.bookings', 'auth.users']) {
    if (!(table in rows)) problems.push(`The data file has nothing for ${table}.`)
  }
  return { problems, rows }
}

/** Warnings when a watched table has lost most of its rows since the last good backup. */
export function suspiciousDrops(previousRows, rows, { minPrevious = 5, keepAtLeast = 0.5 } = {}) {
  const warnings = []
  for (const table of WATCHED_TABLES) {
    const before = previousRows?.[table]
    const now = rows?.[table]
    if (typeof before === 'number' && typeof now === 'number' && before >= minPrevious && now < before * keepAtLeast) {
      warnings.push(`${table} went from ${before} rows to ${now} since the last backup.`)
    }
  }
  return warnings
}

/**
 * Which backup folders to keep: the newest `recent`, plus the newest one of each earlier month for up to `monthly` months.
 * Names this tool did not make are never listed for removal.
 */
export function chooseToKeep(names, { recent = 30, monthly = 3 } = {}) {
  const ours = names.filter(isBackupName).sort().reverse()
  const keep = new Set(ours.slice(0, recent))
  const months = new Set()
  for (const name of ours.slice(recent)) {
    const month = name.slice(0, 7)
    if (months.has(month)) continue
    if (months.size >= monthly) break
    months.add(month)
    keep.add(name)
  }
  return { keep: ours.filter(n => keep.has(n)), remove: ours.filter(n => !keep.has(n)) }
}

/** Whether the newest good backup is recent enough. `goodNames` are folders that hold a finished backup. */
export function checkVerdict(goodNames, now, maxDays = 3) {
  const latest = goodNames.filter(isBackupName).sort().pop()
  if (!latest) return { ok: false, latest: null, ageDays: null, message: 'There is no finished backup yet.' }
  const ageDays = (now - stampToDate(latest)) / DAY
  const when = `${latest.slice(0, 10)} at ${latest.slice(11, 13)}:${latest.slice(13, 15)}`
  const days = Math.floor(ageDays)
  if (ageDays > maxDays) {
    return { ok: false, latest, ageDays, message: `The last good backup was on ${when}, ${days} days ago. Open the backup folder or ask for help.` }
  }
  return { ok: true, latest, ageDays, message: `The last good backup was on ${when}${days >= 1 ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ' (less than a day ago)'}.` }
}

/** True when `child` is the same folder as `parent` or sits inside it. */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
