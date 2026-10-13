// In-memory Firestore for endpoint tests that need to see the ledger EVOLVE
// across several requests (create a route, create another, cancel one…)
// rather than assert on a single captured TxResult.
//
// Semantics kept faithful where the settlement code depends on them:
//   - commit is atomic: every precondition is checked before any write
//     applies, and a failing one throws with nothing written
//   - `currentDocument.exists` true/false preconditions
//   - update without a mask replaces the whole doc; with a mask only the
//     listed top-level fields change
//   - REQUEST_TIME transforms (nested paths too) get one strictly
//     increasing timestamp per commit, like Firestore's commit time
//   - IS_NULL matches only a present null field; IN / EQUAL on strings
//   - `select` projects top-level fields (so a test can catch code that
//     reads a field the projection left out)
// Anything else (transform-only writes, ordering, cursors) is out of scope.
import type { FsValue } from '../../src/firestore'
import type { TxContext, TxQuery, TxReadDoc, TxWrite } from '../../src/firestore-tx'

const PREFIX = 'projects/demo/databases/(default)/documents/'

type Fields = Record<string, FsValue>

export class FakeFirestore {
  readonly docs = new Map<string, Fields>()
  readonly getCalls: string[] = []
  readonly queries: TxQuery[] = []
  readonly commits: TxWrite[][] = []
  private clock = Date.UTC(2026, 9, 13)

  reset(): void {
    this.docs.clear()
    this.getCalls.length = 0
    this.queries.length = 0
    this.commits.length = 0
    this.clock = Date.UTC(2026, 9, 13)
  }

  set(path: string, fields: Fields): void {
    this.docs.set(path, structuredClone(fields))
  }

  fields(path: string): Fields | undefined {
    const f = this.docs.get(path)
    return f ? structuredClone(f) : undefined
  }

  /** Next commit timestamp, also handy for seeding createdAt in order. */
  tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  get(path: string): TxReadDoc {
    this.getCalls.push(path)
    const fields = this.docs.get(path)
    return {
      exists:     fields !== undefined,
      fields:     fields ? structuredClone(fields) : {},
      name:       PREFIX + path,
      updateTime: fields ? new Date(this.clock).toISOString() : null,
    }
  }

  runQuery(query: TxQuery): TxReadDoc[] {
    this.queries.push(structuredClone(query))
    const base = `${query.parent}/${query.collection}/`
    const out: TxReadDoc[] = []
    for (const [path, fields] of [...this.docs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!path.startsWith(base) || path.slice(base.length).includes('/')) continue
      if (!(query.filters ?? []).every(f => matches(fields, f))) continue
      const projected = query.select
        ? Object.fromEntries(Object.entries(fields).filter(([k]) => query.select!.includes(k)))
        : fields
      out.push({ exists: true, fields: structuredClone(projected), name: PREFIX + path, updateTime: null })
    }
    return query.limit !== undefined ? out.slice(0, query.limit) : out
  }

  commit(writes: TxWrite[]): void {
    for (const w of writes) {
      const path = w.document.slice(PREFIX.length)
      const exists = this.docs.has(path)
      if (w.currentDocument?.exists === true && !exists) throw new Error(`NOT_FOUND precondition: ${path}`)
      if (w.currentDocument?.exists === false && exists) throw new Error(`ALREADY_EXISTS precondition: ${path}`)
    }
    const paths = writes.map(w => w.document)
    if (new Set(paths).size !== paths.length) {
      // Real Firestore rejects two writes to one document in a commit.
      throw new Error('INVALID_ARGUMENT: a document may be written once per commit')
    }
    const now = this.tick()
    for (const w of writes) {
      const path = w.document.slice(PREFIX.length)
      if (w.op === 'delete') { this.docs.delete(path); continue }
      if (w.op === 'transform') throw new Error('transform writes are not supported by FakeFirestore')
      const next: Fields = w.updateMask ? structuredClone(this.docs.get(path) ?? {}) : {}
      for (const [k, v] of Object.entries(w.fields)) {
        if (!w.updateMask || w.updateMask.includes(k)) next[k] = structuredClone(v)
      }
      for (const t of w.updateTransforms ?? []) setNested(next, t.fieldPath.split('.'), { timestampValue: now })
      this.docs.set(path, next)
    }
    this.commits.push(writes)
  }

  /** A TxContext + runner equivalent to runFirestoreTransaction. */
  async run<T>(body: (ctx: TxContext) => Promise<{ writes: TxWrite[]; result: T }>): Promise<T> {
    const ctx: TxContext = {
      get:      async path => this.get(path),
      runQuery: async query => this.runQuery(query),
    }
    const { writes, result } = await body(ctx)
    this.commit(writes)
    return result
  }
}

function matches(fields: Fields, f: NonNullable<TxQuery['filters']>[number]): boolean {
  const raw = fields[f.fieldPath] as (FsValue & { nullValue?: null }) | undefined
  if (f.op === 'IS_NULL') return raw !== undefined && 'nullValue' in raw
  if (f.op === 'IS_NOT_NULL') return raw !== undefined && !('nullValue' in raw)
  const value = (raw as { stringValue?: string } | undefined)?.stringValue
  if (f.op === 'EQUAL') return value === (f.value as { stringValue?: string }).stringValue
  if (f.op === 'IN') {
    const allowed = ((f.value as { arrayValue?: { values?: Array<{ stringValue?: string }> } }).arrayValue?.values ?? [])
      .map(v => v.stringValue)
    return value !== undefined && allowed.includes(value)
  }
  throw new Error(`FakeFirestore: unsupported filter op ${f.op}`)
}

function setNested(fields: Fields, path: string[], value: FsValue): void {
  const [head, ...rest] = path
  if (rest.length === 0) { fields[head!] = value; return }
  const child = fields[head!] as { mapValue?: { fields?: Fields } } | undefined
  if (!child?.mapValue) throw new Error(`FakeFirestore: transform parent ${head} is not a map`)
  child.mapValue.fields ??= {}
  setNested(child.mapValue.fields, rest, value)
}

export const fake = new FakeFirestore()
