// workers/ocr/src/firestore.ts
// Thin Firestore REST API client for the operations the cascade-member
// endpoint needs:
//   - getDoc        (check member doc exists; verify caller is in trip)
//   - listDocIds    (collect all docs in a subcollection — admin-side
//                    so the same-doc list rule on memberIds doesn't apply)
//   - batchArrayUnion (commit with fieldTransforms across many docs)
//
// All calls go through https://firestore.googleapis.com with the
// admin OAuth bearer token from admin.ts. No client SDK — Workers
// runtime can't load the firebase-admin Node package.
const BASE = 'https://firestore.googleapis.com/v1'

function docPath(projectId: string, path: string): string {
  return `projects/${projectId}/databases/(default)/documents/${path}`
}
function fullName(projectId: string, path: string): string {
  return `${BASE}/${docPath(projectId, path)}`
}

// Cloudflare Workers `fetch` may cache GET responses based on the
// upstream Cache-Control header. Firestore admin REST normally sets
// no-store, but we belt-and-suspenders bypass cache explicitly —
// the worker's reads are point-in-time membership checks where
// staleness would be a correctness bug, not a perf gain.
const NO_CACHE: RequestInit = { cache: 'no-store' }

/** Check whether a doc exists at the given path. Returns true on 200,
 *  false on 404, throws on any other status. Used to verify the
 *  invitee really wrote their member doc before we cascade. */
export async function docExists(
  accessToken: string,
  projectId:   string,
  path:        string,
): Promise<boolean> {
  const res = await fetch(fullName(projectId, path), {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 200) return true
  if (res.status === 404) return false
  const detail = await res.text().catch(() => '')
  throw new Error(`docExists ${path} → ${res.status}: ${detail.slice(0, 200)}`)
}

/** Read a doc's `memberIds` array via the REST GET endpoint. Returns
 *  an empty array if the field is missing. Throws on any non-2xx. */
export async function getDocMemberIds(
  accessToken: string,
  projectId:   string,
  path:        string,
): Promise<string[]> {
  const res = await fetch(fullName(projectId, path), {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`getDocMemberIds ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as {
    fields?: {
      memberIds?: {
        arrayValue?: { values?: { stringValue?: string }[] }
      }
    }
  }
  return (data.fields?.memberIds?.arrayValue?.values ?? [])
    .map(v => v.stringValue)
    .filter((v): v is string => typeof v === 'string')
}

/** arrayUnion MULTIPLE values onto a single doc's memberIds field.
 *  Used to seed a freshly-created invitee member doc with the full
 *  trip roster — the invitee couldn't read trip.memberIds at create
 *  time so wrote `[invitee.uid]` only; the owner's same-doc
 *  array-contains listener filter never matches that doc. This call
 *  brings the doc up to the same {full roster} as every other
 *  member doc. Idempotent. */
export async function arrayUnionMembersOnDoc(
  accessToken: string,
  projectId:   string,
  docName:     string,
  memberUids:  string[],
): Promise<void> {
  if (memberUids.length === 0) return
  const res = await fetch(
    `${BASE}/projects/${projectId}/databases/(default)/documents:commit`,
    {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        writes: [{
          transform: {
            document: docName,
            fieldTransforms: [{
              fieldPath: 'memberIds',
              appendMissingElements: {
                values: memberUids.map(u => ({ stringValue: u })),
              },
            }],
          },
        }],
      }),
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`arrayUnionMembersOnDoc → ${res.status}: ${detail.slice(0, 200)}`)
  }
}

/** List every document name in a collection. Handles pagination so
 *  large subcollections don't drop docs. Returns the FULL document
 *  resource names (`projects/.../documents/trips/abc/schedules/xyz`)
 *  ready to plug straight into the commit endpoint. */
export async function listDocNames(
  accessToken: string,
  projectId:   string,
  collection:  string,  // e.g. 'trips/abc/schedules'
): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(fullName(projectId, collection))
    // 1000 is Firestore REST's documented max — same single round-trip
    // covers the largest trip we'd realistically see (cascades always
    // run on a single trip's subcollections, never collection-group).
    url.searchParams.set('pageSize', '1000')
    // Only document names needed — `mask.fieldPaths` empty would still
    // return doc bodies. We accept the body cost; collections under a
    // trip stay small (< 200) so the overhead is negligible vs. doing
    // a separate query that strips fields.
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, {
      ...NO_CACHE,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`listDocNames ${collection} → ${res.status}: ${detail.slice(0, 200)}`)
    }
    const data = await res.json() as {
      documents?: { name: string }[]
      nextPageToken?: string
    }
    for (const d of data.documents ?? []) out.push(d.name)
    pageToken = data.nextPageToken
  } while (pageToken)
  return out
}

/** arrayUnion `memberUid` onto every doc's `memberIds` field. Done as
 *  a single Firestore commit when possible (max 500 writes per commit
 *  per the API limit). The transform fieldPath `memberIds` uses
 *  `appendMissingElements` which is the REST equivalent of arrayUnion
 *  in the SDKs — idempotent if uid is already present. */
export async function batchArrayUnionMemberIds(
  accessToken:    string,
  projectId:      string,
  docNames:       string[],
  memberUid:      string,
): Promise<void> {
  if (docNames.length === 0) return
  for (let i = 0; i < docNames.length; i += 500) {
    const chunk = docNames.slice(i, i + 500)
    const writes = chunk.map(name => ({
      transform: {
        document: name,
        fieldTransforms: [
          {
            fieldPath: 'memberIds',
            appendMissingElements: {
              values: [{ stringValue: memberUid }],
            },
          },
        ],
      },
    }))
    const res = await fetch(
      `${BASE}/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ writes }),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`batchArrayUnion → ${res.status}: ${detail.slice(0, 200)}`)
    }
  }
}

/** Convenience: build a full document resource name from a trip-
 *  scoped path so callers can mix listDocNames results with one-off
 *  refs (e.g. the trip doc itself, which doesn't come from a list). */
export function buildDocName(projectId: string, path: string): string {
  return docPath(projectId, path)
}
