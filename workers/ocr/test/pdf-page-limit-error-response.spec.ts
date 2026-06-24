import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
	MAX_PDF_PAGES,
	PDF_PAGE_LIMIT_EXCEEDED,
	PDF_UNREADABLE,
	PdfPageLimitError,
	pdfPageLimitMessageJa,
} from '@tripmate/pdf-page-limit'

const bookingFileCreateMock = vi.hoisted(() => vi.fn())

vi.mock('../src/booking-write', async () => {
	const actual = await vi.importActual<typeof import('../src/booking-write')>('../src/booking-write')
	return {
		...actual,
		bookingFileCreate: (...args: unknown[]) => bookingFileCreateMock(...args),
	}
})

import { ROUTES } from '../src/index'

function bookingFileCreateRoute() {
	const route = ROUTES.find(r => r.path === '/booking-file-create')
	expect(route).toBeDefined()
	return route!
}

function validBookingFileCreateBody() {
	return {
		tripId:    'trip-1',
		bookingId: 'booking-1',
		booking:   { type: 'hotel' },
		attachments: {
			document: ['intent-pdf'],
		},
	}
}

async function dispatchBookingFileCreate(body: unknown): Promise<Response> {
	return bookingFileCreateRoute().dispatch({
		body,
		cors:    {},
		uid:     'user-1',
		traceId: undefined,
		env: {
			FIREBASE_SERVICE_ACCOUNT: '{}',
			FIREBASE_STORAGE_BUCKET:  'bucket',
		},
	} as never)
}

describe('pdfPageLimitErrorCatcher response body', () => {
	beforeEach(() => {
		bookingFileCreateMock.mockReset()
	})

	it('maps PDF_PAGE_LIMIT_EXCEEDED to 413 with stable response shape', async () => {
		bookingFileCreateMock.mockRejectedValueOnce(
			new PdfPageLimitError(PDF_PAGE_LIMIT_EXCEEDED, { pageCount: 11 }),
		)

		const res = await dispatchBookingFileCreate(validBookingFileCreateBody())
		const body = await res.json()

		expect(res.status).toBe(413)
		expect(body).toEqual({
			error:     pdfPageLimitMessageJa(PDF_PAGE_LIMIT_EXCEEDED, MAX_PDF_PAGES),
			code:      PDF_PAGE_LIMIT_EXCEEDED,
			maxPages:  MAX_PDF_PAGES,
			pageCount: 11,
			retryable: false,
		})
	})

	it('maps PDF_UNREADABLE to 400 without pageCount', async () => {
		bookingFileCreateMock.mockRejectedValueOnce(
			new PdfPageLimitError(PDF_UNREADABLE),
		)

		const res = await dispatchBookingFileCreate(validBookingFileCreateBody())
		const body = await res.json() as Record<string, unknown>

		expect(res.status).toBe(400)
		expect(body).toEqual({
			error:     pdfPageLimitMessageJa(PDF_UNREADABLE, MAX_PDF_PAGES),
			code:      PDF_UNREADABLE,
			maxPages:  MAX_PDF_PAGES,
			retryable: false,
		})
		expect(body).not.toHaveProperty('pageCount')
	})
})
