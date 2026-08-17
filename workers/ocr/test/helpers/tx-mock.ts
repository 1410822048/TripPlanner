import type {
  TxContext,
  TxQuery,
  TxReadDoc,
  TxResult,
} from '../../src/firestore-tx'
import { vi } from 'vitest'

interface FirestoreTxMockOptions {
  get: (path: string) => Promise<TxReadDoc>
  runQuery?: (query: TxQuery) => Promise<TxReadDoc[]>
  onResult: (result: TxResult<unknown>) => void
}

export type MockReadDoc = TxReadDoc

/** Replaces the transaction RUNNER only. The returned object is the whole
 *  mocked module, so anything else firestore-tx exports (PostCommitError,
 *  TxRetryExhausted, isPrecommitError…) disappears unless the spec spreads
 *  the real module in first:
 *
 *    vi.mock('../src/firestore-tx', async () => ({
 *      ...await vi.importActual<typeof import('../src/firestore-tx')>('../src/firestore-tx'),
 *      ...createFirestoreTxMock({ ... }),
 *    }))
 *
 *  Do that whenever the code under test constructs or instanceof-checks
 *  one of those classes — otherwise it hits `undefined` and the resulting
 *  TypeError can read like a passing assertion. */

export function createFirestoreTxMock(options: FirestoreTxMockOptions) {
  return {
    runFirestoreTransaction: vi.fn(async <T>(
      _token: string,
      _projectId: string,
      body: (context: TxContext) => Promise<TxResult<T>>,
    ): Promise<T> => {
      const context: TxContext = {
        get: options.get,
        runQuery: options.runQuery ?? (async () => []),
      }
      const result = await body(context)
      options.onResult(result)
      return result.result
    }),
    docResourceName: (projectId: string, path: string) =>
      `projects/${projectId}/databases/(default)/documents/${path}`,
  }
}
