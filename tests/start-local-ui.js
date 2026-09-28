import { spawn } from 'node:child_process'
import process from 'node:process'
import { localConfig } from './localSupabase.js'

const config = localConfig()
const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env,
    VITE_SUPABASE_URL: config.API_URL, VITE_SUPABASE_ANON_KEY: config.ANON_KEY,
    // Deliberately fictitious and restricted to the localhost test server.
    VITE_BANK_ACCOUNT_NAME: 'LOCAL TEST ONLY', VITE_BANK_SORT_CODE: '00-00-00', VITE_BANK_ACCOUNT_NUMBER: '00000000',
  },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())
child.on('exit', (code) => process.exit(code || 0))
