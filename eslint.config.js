import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import reactCompiler from 'eslint-plugin-react-compiler'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // workers/** 是獨立的 Cloudflare Worker package,有自己的 tsconfig
  // 與 wrangler 自動產生的型別檔(worker-configuration.d.ts、test/
  // env.d.ts),不應被 root 的 React/Vite 規則檢查。Worker 內部如果
  // 需要 lint,應該在 workers/ocr/ 內單獨配置。
  globalIgnores(['dist', 'workers/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    // eslint-plugin-react-compiler surfaces violations of the rules-of-react
    // that make the compiler bail out of auto-memoising a component. The
    // codebase is currently at zero violations, so this is `error` rather
    // than `warn`: CI's `eslint .` doesn't fail on warnings (only the
    // pre-commit `--max-warnings 0` does, and only on staged files), so
    // `warn` would let a new violation reach main via --no-verify or a
    // contributor without husky. The one caveat is the plugin is still an
    // RC (19.1.0-rc.x) — if a future bump gets noisier it can hard-block
    // commits; the version is lockfile-pinned, so that only happens on a
    // deliberate upgrade.
    plugins: { 'react-compiler': reactCompiler },
    rules: {
      'react-compiler/react-compiler': 'error',
      // Allow `_`-prefixed args / vars to opt out of the unused check —
      // standard convention for "I know this is unused, kept to match a
      // factory / callback signature". Used in queryKeyFactory / subscribe
      // callbacks that take a uid arg they don't actually need.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
