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
    // that prevent the compiler from auto-memoising a component. Treated
    // as warnings (not errors) for now — existing code may have edge cases
    // that the compiler safely skips, and we don't want CI to red-flag
    // them all at once.
    plugins: { 'react-compiler': reactCompiler },
    rules: {
      'react-compiler/react-compiler': 'warn',
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
