// src/services/uploadIntentEntity.ts
// Phase 3.7 shared "mint intents → upload full + optional thumb"
// composer. Booking, wish, and expense all repeat this exact 4-step
// dance (decide primary kind from contentType, push optional thumb,
// requestUploadIntents, parallel uploadToIntent with kind-scoped log
// label). This helper consolidates the plumbing; entity-shaped concerns
// (which Worker endpoint, body schema, rollback policy, purge ladder)
// stay at each feature service.
//
// Lives in its own file (not inline in uploadIntent.ts) so feature-level
// service tests can keep `vi.mock('@/services/uploadIntent', ...)` to
// stub the primitives while the real helper continues to exercise the
// "uploads array + intent pairing + label" plumbing. Co-locating the
// helper with the primitives would short-circuit those mocks via ESM
// intra-module bindings.
//
// Observability: this composer mints a per-flow `traceId` (full UUID,
// header-only — never enters body schemas or Storage customMetadata) and
// returns it so the feature service can forward it to the downstream
// entity-write workerFetch. Sentry breadcrumbs at each stage carry the
// same traceId, and the Worker echoes it into its log lines, so an error
// event reconstructs the full mint → upload → write chain.

import {
  requestUploadIntents,
  uploadToIntent,
  type IntentEntityType,
  type IntentKind,
  type UploadIntentsRequest,
} from './uploadIntent'
import { breadcrumb } from './sentry'
import type { CompressedImage } from '@/utils/image'

/**
 * Mint upload intents + upload the compressed primary (and optional
 * thumb). Returns intentIds for the Worker call, paths for the
 * explicit-rollback callers (expense), AND the per-flow traceId so the
 * feature service can pass it to the entity-write workerFetch — that
 * second call shares the same `X-Upload-Trace-Id` header value as the
 * /upload-intents request and the breadcrumbs left here.
 *
 * Primary kind is `'pdf'` for `application/pdf`, `'full'` otherwise.
 * Thumb is optional -- HEIC/HEIF passthrough and PDF receipts ship
 * `compressed.thumb === undefined`, in which case only the primary
 * intent is minted and uploaded.
 *
 * The label passed to uploadToIntent is `${entityType}-${primaryKind}`
 * for the primary (`booking-full`, `expense-pdf`, etc.) and
 * `${entityType}-thumb` for the thumb -- only used for timeout error
 * messages and Sentry tagging, not load-bearing.
 */
export async function mintAndUploadEntityIntents(args: {
  tripId:     string
  entityType: IntentEntityType
  entityId:   string
  compressed: CompressedImage
  mode?:      'create' | 'update'
}): Promise<{ intentIds: string[]; paths: string[]; traceId: string }> {
  const { tripId, entityType, entityId, compressed, mode } = args
  const { full, thumb } = compressed
  const primaryKind: IntentKind = full.type === 'application/pdf' ? 'pdf' : 'full'
  // Full UUID (36 chars). Header validator accepts {12,64} so we have
  // headroom; using the full UUID keeps collision probability negligible
  // even across long-tail sessions, and there's no log-width pressure
  // here (Worker echoes it as `trace=<uuid>` at the end of each log
  // line). slice(0,8) was rejected for being too short to confidently
  // dedupe with naked-eye scanning across concurrent uploads.
  const traceId = crypto.randomUUID()

  breadcrumb({
    category: 'upload',
    message:  'mint-intents',
    data:     { traceId, entityType, entityId, tripId, primaryKind, hasThumb: !!thumb, mode },
  })

  const uploads: UploadIntentsRequest['uploads'] = [
    { kind: primaryKind, contentType: full.type, size: full.size },
  ]
  if (thumb) {
    uploads.push({ kind: 'thumb', contentType: thumb.type, size: thumb.size })
  }
  const intents = await requestUploadIntents(
    { tripId, entityType, entityId, uploads, mode },
    { traceId },
  )
  // Pair intents to uploads by `customMetadata.kind`, not by array
  // index. Worker currently preserves request order in its response,
  // but that's not contractually pinned — a future internal refactor
  // (e.g. Promise.all of mint-per-upload) could reorder. Index-based
  // pairing would then silently route the full File to the thumb
  // intent (writing the receipt body to a *.thumb.webp path) and
  // vice versa; by-kind pairing fails fast instead.
  const byKind = new Map(intents.map(i => [i.metadata.customMetadata.kind, i]))
  const primaryIntent = byKind.get(primaryKind)
  if (!primaryIntent) {
    throw new Error(`upload-intents response missing ${primaryKind} intent`)
  }
  const thumbIntent = thumb ? byKind.get('thumb') : undefined
  if (thumb && !thumbIntent) {
    throw new Error('upload-intents response missing thumb intent')
  }

  // Per-kind start/done breadcrumbs so a Sentry error during the
  // Promise.all narrows down which leg blew up. We don't try/catch
  // per upload here -- Promise.all surfaces the first rejection and
  // the breadcrumb timeline shows the missing `*-done` to identify it.
  const uploadOne = async (intent: typeof primaryIntent, file: Blob, kind: IntentKind, label: string) => {
    breadcrumb({
      category: 'upload',
      message:  'storage-upload-start',
      data:     { traceId, kind, path: intent.path },
    })
    await uploadToIntent(intent, file, label)
    breadcrumb({
      category: 'upload',
      message:  'storage-upload-done',
      data:     { traceId, kind },
    })
  }

  await Promise.all([
    uploadOne(primaryIntent, full, primaryKind, `${entityType}-${primaryKind}`),
    thumb && thumbIntent
      ? uploadOne(thumbIntent, thumb, 'thumb', `${entityType}-thumb`)
      : Promise.resolve(),
  ])
  return {
    intentIds: intents.map(i => i.intentId),
    paths:     intents.map(i => i.path),
    traceId,
  }
}
