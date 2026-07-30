import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { loadEnv } from 'vite'

export const PROJECT_NAME = 'tripmate'
export const PAGES_DEV_DOMAIN = 'tripmate-2wg.pages.dev'
export const PRODUCTION_BRANCH = 'main'
export const WORKER_URL = 'https://tripmate-ocr.tripmate.workers.dev'
export const REQUIRED_CLIENT_ENV = [
  'VITE_WORKER_BASE_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_VAPID_KEY',
  'VITE_FIREBASE_APP_ID',
]

export function abort(message) {
  console.error(message)
  process.exit(1)
}

export function run(command, extraEnv) {
  return execSync(command, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
}

export function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim()
}

export function loadClientEnv() {
  return { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env }
}

export function assertDistReady(prefix) {
  if (!fs.existsSync('dist/index.html')) {
    abort(`[${prefix}] ABORT: dist/index.html not found; run without --deploy-only first.`)
  }
}
