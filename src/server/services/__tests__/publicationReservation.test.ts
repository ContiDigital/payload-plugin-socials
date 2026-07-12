import type { Payload } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import { ConflictError } from '../../utilities/errors.js'
import { failPublicationReservation, reservePublication } from '../publicationReservation.js'

const args = (payload: Payload) => ({
  destinationId: 'board_1',
  idempotencyKey: 'key_1',
  imageUrl: 'https://cdn.example/image.jpg',
  payload,
  platform: 'pinterest' as const,
  sourceHash: 'hash_1',
  sourceId: 'source_1',
  sourceKind: 'product',
  title: 'Title',
})

describe('publication reservations', () => {
  it('creates a publishing row before the external request starts', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'post_1' })
    const payload = {
      create,
      find: vi.fn().mockResolvedValue({ docs: [] }),
    } as unknown as Payload

    await expect(reservePublication(args(payload))).resolves.toEqual({
      claimed: true,
      postId: 'post_1',
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'publishing' }),
      }),
    )
  })

  it('returns an already-published reference without claiming it', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({
        docs: [
          {
            id: 'post_1',
            externalId: 'pin_1',
            externalUrl: 'https://pinterest.com/pin/1',
            status: 'published',
          },
        ],
      }),
    } as unknown as Payload

    const reservation = await reservePublication(args(payload))
    expect(reservation.claimed).toBe(false)
    expect(reservation.publishedRef?.externalId).toBe('pin_1')
  })

  it('rejects a duplicate that is queued or already in progress', async () => {
    const payload = {
      find: vi.fn().mockResolvedValue({ docs: [{ id: 'post_1', status: 'publishing' }] }),
      update: vi.fn().mockResolvedValue({ docs: [], errors: [] }),
    } as unknown as Payload

    await expect(reservePublication(args(payload))).rejects.toBeInstanceOf(ConflictError)
  })

  it('atomically reclaims a failed publication', async () => {
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 'post_1' }], errors: [] })
    const payload = {
      find: vi.fn().mockResolvedValue({ docs: [{ id: 'post_1', status: 'failed' }] }),
      update,
    } as unknown as Payload

    await expect(reservePublication(args(payload))).resolves.toEqual({
      claimed: true,
      postId: 'post_1',
    })
    expect(update).toHaveBeenCalledOnce()
  })

  it('regression: reclaims a failed row (claimed: true) instead of throwing ConflictError when bulk update returns real BulkOperationResult', async () => {
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 'post_99' }], errors: [] })
    const payload = {
      find: vi.fn().mockResolvedValue({ docs: [{ id: 'post_99', status: 'failed' }] }),
      update,
    } as unknown as Payload

    const reservation = await reservePublication(args(payload))
    expect(reservation).toEqual({ claimed: true, postId: 'post_99' })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'publishing' }),
        where: expect.objectContaining({
          and: expect.arrayContaining([
            { id: { equals: 'post_99' } },
            { status: { in: ['cancelled', 'draft', 'failed'] } },
          ]),
        }),
      }),
    )
  })

  it('marks a claimed row failed and redacts secrets', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'post_1' })
    const payload = { update } as unknown as Payload
    await failPublicationReservation(
      payload,
      { claimed: true, postId: 'post_1' },
      new Error('access_token=secret-value'),
    )
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: 'access_token=[REDACTED]', status: 'failed' }),
      }),
    )
  })
})
