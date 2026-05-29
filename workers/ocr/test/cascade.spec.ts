// Unit tests for the cascade 401-retry policy. The retry logic is
// extracted into withTokenRetry() so it can be exercised without
// mocking the entire Firestore REST helper stack -- the policy is
// pure (catch error, sniff message, invalidate-and-retry once) and
// belongs at the test boundary independent of the cascade body.
//
// Also: the removal-aware refuse in cascadeMemberAdd is exercised
// via a tightly-mocked happy/refuse pair -- the security-critical
// invariant ("a member not in trip.memberIds cannot re-cascade
// themselves back in") earns a dedicated test even though the rest
// of the cascade body has no other unit coverage.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		...actual,
		docExists:                vi.fn(async () => true),
		getDocFields:             vi.fn(async () => ({})),
		getDocMemberIds:          vi.fn(async () => [] as string[]),
		listDocNames:             vi.fn(async () => [] as string[]),
		batchArrayUnionMemberIds: vi.fn(async () => undefined),
		arrayUnionMembersOnDoc:   vi.fn(async () => undefined),
		buildDocName:             (pid: string, p: string) => `projects/${pid}/databases/(default)/documents/${p}`,
	}
})

import { withTokenRetry, cascadeMemberAdd, CascadeError } from '../src/cascade'
import * as admin from '../src/admin'
import * as firestore from '../src/firestore'

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(admin.getAdminToken).mockResolvedValue('fake-admin-token')
	vi.mocked(admin.getProjectId).mockReturnValue('demo')
	vi.mocked(firestore.docExists).mockResolvedValue(true)
	vi.mocked(firestore.getDocFields).mockResolvedValue({})
	vi.mocked(firestore.getDocMemberIds).mockResolvedValue([])
	vi.mocked(firestore.listDocNames).mockResolvedValue([])
})

describe('withTokenRetry', () => {
	it('returns the result when fn succeeds on first try', async () => {
		const fn = vi.fn(async () => 'ok')
		const invalidateSpy = vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})
		const result = await withTokenRetry(fn)
		expect(result).toBe('ok')
		expect(fn).toHaveBeenCalledTimes(1)
		expect(invalidateSpy).not.toHaveBeenCalled()
	})

	it('on Firestore 401 error: invalidates token + retries exactly once', async () => {
		const fn = vi.fn()
			.mockRejectedValueOnce(new Error('docExists trips/x/members/y -> 401: token expired'))
			.mockResolvedValueOnce({ updatedDocs: 5 })
		const invalidateSpy = vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})

		const result = await withTokenRetry(fn)
		expect(result).toEqual({ updatedDocs: 5 })
		expect(fn).toHaveBeenCalledTimes(2)
		expect(invalidateSpy).toHaveBeenCalledTimes(1)
	})

	it('non-401 errors propagate without retry', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('listDocNames foo -> 500: upstream'))
		const invalidateSpy = vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})
		await expect(withTokenRetry(fn)).rejects.toThrow('500')
		expect(fn).toHaveBeenCalledTimes(1)
		expect(invalidateSpy).not.toHaveBeenCalled()
	})

	it('does not retry a second 401: at most one retry per call', async () => {
		const fn = vi.fn()
			.mockRejectedValueOnce(new Error('docExists -> 401: first'))
			.mockRejectedValueOnce(new Error('docExists -> 401: second'))
		vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})
		await expect(withTokenRetry(fn)).rejects.toThrow('second')
		expect(fn).toHaveBeenCalledTimes(2)
	})
})

describe('cascadeMemberAdd removal-aware refuse', () => {
	// Build a Firestore REST "fields" object containing memberIds with
	// the given uids. Mirrors the shape getDocFields returns -- the cascade
	// code reads tripFields.memberIds?.arrayValue?.values directly.
	const tripFieldsWithRoster = (uids: string[]) => ({
		memberIds: {
			arrayValue: { values: uids.map(stringValue => ({ stringValue })) },
		},
	})

	it('proceeds when target uid is in trip.memberIds (happy path)', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(
			tripFieldsWithRoster(['caller-uid', 'other-member']),
		)
		vi.mocked(firestore.getDocMemberIds).mockResolvedValueOnce(['caller-uid', 'other-member'])

		const result = await cascadeMemberAdd(
			'caller-uid',
			{ tripId: 'trip-1', memberUid: 'caller-uid' },
			'{}',
		)

		// Trip doc itself is pushed onto docNames after the 6 subcollection
		// list results (each defaulted to [] by the global mock), so
		// updatedDocs = 1.
		expect(result.updatedDocs).toBe(1)
		expect(firestore.batchArrayUnionMemberIds).toHaveBeenCalledTimes(1)
		expect(firestore.arrayUnionMembersOnDoc).toHaveBeenCalledTimes(1)
	})

	it('refuses with 403 when target uid is NOT in trip.memberIds (kick in progress)', async () => {
		// member doc still exists (kick hasn't deleted it yet) but ACL strip
		// already removed the uid from trip.memberIds -- this is the exact
		// state where a re-cascade would silently undo the kick.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(
			tripFieldsWithRoster(['someone-else']),
		)

		await expect(
			cascadeMemberAdd(
				'caller-uid',
				{ tripId: 'trip-1', memberUid: 'caller-uid' },
				'{}',
			),
		).rejects.toThrow(CascadeError)

		// Critical: no writes happen on the refuse path. If
		// batchArrayUnionMemberIds were called we'd be silently undoing
		// the kick.
		expect(firestore.batchArrayUnionMemberIds).not.toHaveBeenCalled()
		expect(firestore.arrayUnionMembersOnDoc).not.toHaveBeenCalled()
	})

	it('refuses with 403 when trip.memberIds is missing entirely', async () => {
		// Empty fields = no memberIds key at all. Defensive: a malformed or
		// freshly-soft-deleted trip should not accidentally pass the gate.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({})

		await expect(
			cascadeMemberAdd(
				'caller-uid',
				{ tripId: 'trip-1', memberUid: 'caller-uid' },
				'{}',
			),
		).rejects.toThrow(/cascade refused/)

		expect(firestore.batchArrayUnionMemberIds).not.toHaveBeenCalled()
	})
})
