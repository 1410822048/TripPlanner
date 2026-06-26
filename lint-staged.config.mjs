import { fileURLToPath } from 'node:url'

const eslintCli = fileURLToPath(new URL('./node_modules/eslint/bin/eslint.js', import.meta.url))
const quote = value => JSON.stringify(value)

export default {
  '*.{ts,tsx}': files => {
    if (files.length === 0) return []
    return `${quote(process.execPath)} ${quote(eslintCli)} --max-warnings 0 --no-warn-ignored ${files.map(quote).join(' ')}`
  },
}
