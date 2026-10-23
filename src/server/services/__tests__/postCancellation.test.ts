import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { ConflictError, NotFoundError } from '../../utilities/errors.js'
import { cancelQueuedSocialPost } from '../postCancellation.js'

const queued = {
  id: 7,
  meta: { queuedInput: { pageId: 'p' }, scheduleToken: 't' },
  queuedJobId: '55',
  scheduledAt: '2027-01-01T12:00:00.000Z',
  status: 'queued',
}

const fakePayload = (rows: unknown[], updated: unknown[] = [{ id: 7 }]) => {
  const findByID = vi.fn()
  for (const row of rows) {
    findByID.mockResolvedValueOnce(row)
  }
  return {
    findByID,
    jobs: { cancelByID: vi.fn().mockRejectedValue(new Error('job already running')) },
    update: vi.fn().mockResolvedValue({ docs: updated }),
  }
}

describe('cancelQueuedSocialPost', () => {
  it('cancels in one guarded update and keeps the existing meta', async () => {
    const payload = fakePayload([queued])
    const now = new Date('2027-01-01T11:00:00.000Z')
    await expect(
      cancelQueuedSocialPost({
        minLeadSeconds: 300,
        now,
        payload: payload as unknown as Payload,
        postId: 7,
        userId: 3,
      }),
    ).resolves.toEqual({ postId: 7, status: 'cancelled' })
    const arg = payload.update.mock.calls[0][0]
    expect(arg.where).toEqual({
      and: [
        { id: { equals: 7 } },
        { status: { equals: 'queued' } },
        { scheduledAt: { greater_than: '2027-01-01T11:05:00.000Z' } },
      ],
    })
    expect(arg.data).toEqual({
      meta: {
        cancelledAt: now.toISOString(),
        cancelledBy: 3,
        queuedInput: { pageId: 'p' },
        scheduleToken: 't',
      },
      status: 'cancelled',
    })
    expect(payload.jobs.cancelByID).toHaveBeenCalledWith({ id: '55' })
  })

  it('omits the lead condition when none is asked for', async () => {
    const payload = fakePayload([queued])
    await cancelQueuedSocialPost({ payload: payload as unknown as Payload, postId: 7 })
    expect(payload.update.mock.calls[0][0].where.and).toHaveLength(2)
  })

  it('refuses a row that is not queued without updating it', async () => {
    const payload = fakePayload([{ ...queued, status: 'scheduled' }])
    await expect(
      cancelQueuedSocialPost({ payload: payload as unknown as Payload, postId: 7 }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(payload.update).not.toHaveBeenCalled()
  })

  it('names the new status when the publish task won the race', async () => {
    const payload = fakePayload([queued, { ...queued, status: 'publishing' }], [])
    await expect(
      cancelQueuedSocialPost({ payload: payload as unknown as Payload, postId: 7 }),
    ).rejects.toThrow(/this post is publishing/)
    expect(payload.jobs.cancelByID).not.toHaveBeenCalled()
  })

  it('throws NotFoundError for a missing row', async () => {
    const payload = fakePayload([null])
    await expect(
      cancelQueuedSocialPost({ payload: payload as unknown as Payload, postId: 8 }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
