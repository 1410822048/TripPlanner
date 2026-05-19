// Unit tests for the cascade 401-retry policy. The retry logic is
// extracted into withTokenRetry() so it can be exercised without
// mocking the entire Firestore REST helper stack -- the policy is
// pure (catch error, sniff message, invalidate-and-retry once) and
// belongs at the test boundary independent of the cascade body.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withTokenRetry } from '../src/cascade'
import * as admin from '../src/admin'

beforeEach(() => {
	vi.restoreAllMocks()
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
