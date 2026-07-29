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
