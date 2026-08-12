import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot  = fileURLToPath(new URL('.', import.meta.url))
const eslintCli = fileURLToPath(new URL('./node_modules/eslint/bin/eslint.js', import.meta.url))
const quote = value => JSON.stringify(value)

// The Worker has its own ESLint config — the root one globally ignores
// `workers/**` because its React/Vite rules do not belong there. Running
// the root binary over a staged Worker file therefore lints NOTHING, and
// `--no-warn-ignored` means it does so silently. Split the batch by which
// config owns the file and point eslint at the right one.
//
// `--config` rather than a `cd &&` prefix: lint-staged executes the
// command directly instead of through a shell, so a compound command is
// looked up as a binary named `cd`.
const WORKER_DIR    = path.join(repoRoot, 'workers', 'ocr')
const WORKER_CONFIG = path.join(WORKER_DIR, 'eslint.config.mjs')

const isWorkerFile = file => !path.relative(WORKER_DIR, file).startsWith('..')

const eslintCommand = (files, configPath) => [
  quote(process.execPath),
  quote(eslintCli),
  ...(configPath ? ['--config', quote(configPath)] : []),
  '--max-warnings 0 --no-warn-ignored',
  ...files.map(quote),
].join(' ')

export default {
  '*.{ts,tsx}': files => {
    if (files.length === 0) return []
    const workerFiles = files.filter(isWorkerFile)
    const rootFiles   = files.filter(file => !isWorkerFile(file))

    const commands = []
    if (rootFiles.length   > 0) commands.push(eslintCommand(rootFiles))
    if (workerFiles.length > 0) commands.push(eslintCommand(workerFiles, WORKER_CONFIG))
    return commands
  },
}
