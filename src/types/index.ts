// src/types/index.ts
// Barrel re-export so existing call sites (`import { ... } from '@/types'`)
// keep working unchanged. New code can import directly from the per-entity
// file (`@/types/booking`) when the call site is closely scoped, but going
// through the barrel is fine — Vite tree-shakes unused exports at build.

export * from './_shared'
export * from './trip'
export * from './schedule'
export * from './expense'
export * from './booking'
export * from './wish'
export * from './planning'
