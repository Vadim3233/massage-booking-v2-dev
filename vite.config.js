import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Integration suites share local Supabase; its Windows CLI telemetry file is not concurrency-safe.
  test: { include: ['src/**/*.test.{js,jsx}', 'server/**/*.test.js'], fileParallelism: false },
})
