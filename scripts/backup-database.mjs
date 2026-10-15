// Saves a full copy of the online database (structure, data and logins) to this PC.
//
//   node scripts/backup-database.mjs                          back up the online project
//   node scripts/backup-database.mjs --check [--popup]        say how old the last good backup is (exit 1 when too old)
//   node scripts/backup-database.mjs --local --out <folder>   rehearse on the local test database
//   options: --out <folder>  --keep <n> (default 30)  --monthly <n> (default 3)  --max-days <n> (default 3)
//
// The connection string is read from the BACKUP_DB_URL setting, or from the first line of
// %USERPROFILE%\.vad-backup\db-url.txt. It is never printed or logged.
// Backups hold client details and the repository is public, so a backup folder must never sit inside a git checkout.
// It uses the Supabase tool already in the project's node_modules (set SUPABASE_CLI_JS to point at another copy),
// which runs pg_dump in Docker, so Docker Desktop has to be running (the script starts it if it can).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVerdict, chooseToKeep, humanSize, isBackupName, parseDbUrl, redact, stamp, suspiciousDrops, verifyDump } from './backup-lib.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOut = path.join(os.homedir(), 'VadMassage-Backups')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let logFile = null
function log(message) {
  const line = `${new Date().toLocaleString('sv-SE')}  ${message}`
  console.log(message)
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`)
    } catch {
      // The log is a convenience; never let it stop a backup.
    }
  }
}

function readDbUrl() {
  const fromSetting = process.env.BACKUP_DB_URL?.trim()
  if (fromSetting) return fromSetting
  const file = path.join(os.homedir(), '.vad-backup', 'db-url.txt')
  if (!existsSync(file)) throw new Error(`No connection string found. Save it as the first line of ${file} (the steps are in docs/SAFETY_NET.md).`)
  const line = readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'))
  if (!line) throw new Error(`${file} is empty.`)
  return line
}

function findCli() {
  const found = [process.env.SUPABASE_CLI_JS, path.join(repoRoot, 'node_modules', 'supabase', 'dist', 'supabase.js')].filter(Boolean).find(existsSync)
  if (!found) throw new Error('Cannot find the Supabase tool. Set SUPABASE_CLI_JS to the path of node_modules\\supabase\\dist\\supabase.js inside the project folder.')
  return found
}

const dockerReady = () => spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 }).status === 0

async function ensureDocker() {
  if (dockerReady()) return
  const exe = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe')
  if (process.platform === 'win32' && existsSync(exe)) {
    log('Docker is not running. Starting Docker Desktop (this can take a minute or two)...')
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
    for (let waited = 0; waited < 180; waited += 5) {
      await sleep(5000)
      if (dockerReady()) return
    }
  }
  throw new Error('Docker Desktop is not running and the backup needs it. Start Docker Desktop and run the backup again.')
}

/** The nearest folder that already exists, so a folder-to-be can still be checked. */
function nearestExisting(dir) {
  let current = dir
  while (!existsSync(current) && path.dirname(current) !== current) current = path.dirname(current)
  return current
}

function insideGitCheckout(dir) {
  const result = spawnSync('git', ['-C', nearestExisting(dir), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 15_000 })
  return result.status === 0 && result.stdout.trim() === 'true'
}

const lastLines = text => text.split(/\r?\n/).filter(l => l.trim() && !/new version of Supabase CLI/i.test(l)).slice(-5).join(' ').slice(0, 600)

function dump({ cli, target, cwd, file, extra = [], secrets }) {
  const result = spawnSync(process.execPath, [cli, 'db', 'dump', ...(target ? ['--db-url', target] : ['--local']), '-f', file, ...extra], {
    cwd,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const why = redact(`${result.stderr ?? ''} ${result.error?.message ?? ''}`, secrets)
    throw new Error(`${path.basename(file)} could not be saved: ${lastLines(why) || 'no reason given'}`)
  }
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

function goodBackups(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => isBackupName(name) && existsSync(path.join(root, name, 'manifest.json')))
}

async function backup() {
  const local = flag('local')
  const out = option('out', local ? null : defaultOut)
  if (!out) throw new Error('--local needs --out <folder>, so a rehearsal never lands among the real backups.')
  const root = path.resolve(out)
  if (insideGitCheckout(root)) throw new Error(`${root} is inside a git checkout. Backups hold client details and the repository is public, so choose a folder outside the project.`)
  mkdirSync(root, { recursive: true })
  logFile = path.join(root, 'backup.log')

  const dbUrl = local ? null : readDbUrl()
  const parsed = dbUrl ? parseDbUrl(dbUrl) : null
  const secrets = parsed ? [dbUrl, parsed.password] : []
  if (parsed?.direct) log('Note: this is the direct address, which only works on a network with IPv6. If the backup fails, use the Session pooler address instead.')

  for (const entry of readdirSync(root)) if (entry.startsWith('.partial-')) rmSync(path.join(root, entry), { recursive: true, force: true })
  const name = stamp(new Date())
  const finalDir = path.join(root, name)
  if (existsSync(finalDir)) {
    log(`A backup named ${name} already exists, so nothing was done.`)
    return 0
  }
  const partial = path.join(root, `.partial-${name}`)
  mkdirSync(partial)

  // The Supabase tool wants a project folder for the local database; for the online one any quiet folder will do.
  const cwd = local ? repoRoot : path.join(os.tmpdir(), 'vad-backup-work')
  mkdirSync(cwd, { recursive: true })

  const warnings = []
  try {
    await ensureDocker()
    const cli = findCli()
    log(`Saving a copy of the ${local ? 'local test' : 'online'} database...`)
    const files = { schema: 'schema.sql', data: 'data.sql', roles: 'roles.sql' }
    dump({ cli, target: dbUrl, cwd, file: path.join(partial, files.schema), secrets })
    dump({ cli, target: dbUrl, cwd, file: path.join(partial, files.data), extra: ['--use-copy', '--data-only', '-x', 'storage.buckets_vectors', '-x', 'storage.vector_indexes'], secrets })
    try {
      dump({ cli, target: dbUrl, cwd, file: path.join(partial, files.roles), extra: ['--role-only'], secrets })
    } catch (error) {
      warnings.push(`The roles file was not saved (${error.message}). The structure and data are fine; a new project already has the standard roles.`)
    }

    const { problems, rows } = verifyDump({
      schemaSql: readFileSync(path.join(partial, files.schema), 'utf8'),
      dataSql: readFileSync(path.join(partial, files.data), 'utf8'),
    })
    if (problems.length) throw new Error(`The copy does not look complete: ${problems.join(' ')}`)

    const previousName = goodBackups(root).sort().pop()
    const previous = previousName ? JSON.parse(readFileSync(path.join(root, previousName, 'manifest.json'), 'utf8')) : null
    warnings.push(...suspiciousDrops(previous?.rows, rows))

    const saved = Object.fromEntries(
      readdirSync(partial).map(file => [file, { bytes: statSync(path.join(partial, file)).size, sha256: sha256(path.join(partial, file)) }]),
    )
    writeFileSync(
      path.join(partial, 'manifest.json'),
      JSON.stringify({ format: 1, ok: true, createdAt: new Date().toISOString(), source: local ? 'local test database' : `online project (${parsed.host})`, files: saved, rows, warnings }, null, 2),
    )
    renameSync(partial, finalDir)

    const total = Object.values(saved).reduce((sum, f) => sum + f.bytes, 0)
    log(`Backup saved: ${finalDir} (${humanSize(total)}).`)
    log(`Contents: ${rows['public.clients'] ?? 0} clients, ${rows['public.bookings'] ?? 0} bookings, ${rows['public.booking_receipts'] ?? 0} receipts, ${rows['auth.users'] ?? 0} logins.`)
    for (const warning of warnings) log(`WARNING: ${warning}`)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }

  const { remove } = chooseToKeep(readdirSync(root), { recent: Number(option('keep', 30)), monthly: Number(option('monthly', 3)) })
  for (const old of remove) rmSync(path.join(root, old), { recursive: true, force: true })
  if (remove.length) log(`Removed ${remove.length} older backup${remove.length === 1 ? '' : 's'}.`)
  return 0
}

function popup(message) {
  if (process.platform !== 'win32') return
  const text = message.replace(/'/g, "''")
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Vad Massage backup', 'OK', 'Warning') | Out-Null`], { timeout: 10 * 60_000 })
}

function check() {
  const root = path.resolve(option('out', defaultOut))
  const good = goodBackups(root)
  const verdict = checkVerdict(good, new Date(), Number(option('max-days', 3)))
  console.log(verdict.message)
  if (verdict.latest) {
    const manifest = JSON.parse(readFileSync(path.join(root, verdict.latest, 'manifest.json'), 'utf8'))
    for (const warning of manifest.warnings ?? []) console.log(`WARNING: ${warning}`)
  }
  if (!verdict.ok && flag('popup')) popup(`Your booking data has not been backed up recently.\n\n${verdict.message}\n\nBackups are kept in ${root}`)
  return verdict.ok ? 0 : 1
}

if (flag('help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
  process.exit(0)
}

try {
  process.exit(flag('check') ? check() : await backup())
} catch (error) {
  const message = redact(error.message)
  log(`Backup failed: ${message}`)
  process.exit(1)
}
