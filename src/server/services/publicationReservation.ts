import type { Payload } from 'payload'

import type { PlatformId, PublishedRef } from '../../types/index.js'

import { SOCIAL_POSTS_SLUG } from '../../constants.js'
import { ConflictError } from '../utilities/errors.js'
import { redactSecretString } from '../utilities/logger.js'

type ReservationRow = {
  externalId?: null | string
  externalUrl?: null | string
  id: number | string
  status: string
}

const findByKey = async (
  payload: Payload,
  idempotencyKey: string,
): Promise<null | ReservationRow> => {
  const result = await payload.find({
    collection: SOCIAL_POSTS_SLUG as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { idempotencyKey: { equals: idempotencyKey } },
  })
  return (result.docs[0] as ReservationRow | undefined) ?? null
}

export type PublicationReservation = {
  claimed: boolean
  postId: number | string
  publishedRef?: PublishedRef
}

export const reservePublication = async (args: {
  destinationId: string
  idempotencyKey: string
  imageUrl?: string
  payload: Payload
  platform: PlatformId
  sourceHash: string
  sourceId: string
  sourceKind: string
  title?: string
}): Promise<PublicationReservation> => {
  const existing = await findByKey(args.payload, args.idempotencyKey)
  if (existing?.status === 'published' && existing.externalId) {
    return {
      claimed: false,
      postId: existing.id,
      publishedRef: {
        externalId: existing.externalId,
        externalUrl: existing.externalUrl ?? undefined,
        platform: args.platform,
      },
    }
  }
  if (existing) {
    const result = (await args.payload.update({
      collection: SOCIAL_POSTS_SLUG as never,
      data: { lastAttemptedAt: new Date().toISOString(), status: 'publishing' } as never,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { id: { equals: existing.id } },
          { status: { in: ['cancelled', 'draft', 'failed'] } },
        ],
      },
    } as never)) as unknown as { totalDocs?: number }
    if (result.totalDocs !== 1) {
      throw new ConflictError('an identical publication is already queued or in progress')
    }
    return { claimed: true, postId: existing.id }
  }

  try {
    const created = (await args.payload.create({
      collection: SOCIAL_POSTS_SLUG as never,
      data: {
        destination: { id: args.destinationId },
        idempotencyKey: args.idempotencyKey,
        imageUrl: args.imageUrl,
        lastAttemptedAt: new Date().toISOString(),
        platform: args.platform,
        sourceHash: args.sourceHash,
        sourceId: args.sourceId,
        sourceKind: args.sourceKind,
        status: 'publishing',
        title: args.title,
      } as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }
    return { claimed: true, postId: created.id }
  } catch (error) {
    if (await findByKey(args.payload, args.idempotencyKey)) {
      throw new ConflictError('an identical publication is already queued or in progress')
    }
    throw error
  }
}

export const failPublicationReservation = async (
  payload: Payload,
  reservation: PublicationReservation,
  error: unknown,
): Promise<void> => {
  if (!reservation.claimed) {
    return
  }
  try {
    await payload.update({
      id: reservation.postId as never,
      collection: SOCIAL_POSTS_SLUG as never,
      data: {
        lastAttemptedAt: new Date().toISOString(),
        lastError: redactSecretString(error instanceof Error ? error.message : String(error)),
        status: 'failed',
      } as never,
      overrideAccess: true,
    })
  } catch {
    // Preserving the publish error is more important than the cleanup failure.
  }
}
