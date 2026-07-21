import type { Payload } from 'payload'

import type { PlatformId, PublishedRef } from '../../types/index.js'

import { SOCIAL_POSTS_SLUG } from '../../constants.js'
import {
  ConflictError,
  getUnknownPublicationRef,
  hasUnknownPublicationOutcome,
} from '../utilities/errors.js'
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

/**
 * Statuses that an existing row may have when it is eligible for re-claim.
 *
 * `deleted` rows are treated as re-claimable so that publishing the same
 * content after deletion overwrites the SAME row back to published, preserving
 * the audit trail as a single row per idempotency key.
 */
const RECLAIMABLE_STATUSES = ['cancelled', 'deleted', 'draft', 'failed'] as const

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
        and: [{ id: { equals: existing.id } }, { status: { in: [...RECLAIMABLE_STATUSES] } }],
      },
    } as never)) as unknown as { docs?: unknown[] }
    if ((result.docs?.length ?? 0) !== 1) {
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
  if (hasUnknownPublicationOutcome(error)) {
    await markPublicationOutcomeUnknown(
      payload,
      reservation.postId,
      getUnknownPublicationRef(error),
    )
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

export const markPublicationOutcomeUnknown = async (
  payload: Payload,
  postId: number | string,
  publishedRef?: PublishedRef,
): Promise<void> => {
  try {
    const data: Record<string, unknown> = {
      ...(publishedRef
        ? { externalId: publishedRef.externalId, externalUrl: publishedRef.externalUrl }
        : {}),
      lastAttemptedAt: new Date().toISOString(),
      lastError: publishedRef
        ? 'The provider accepted this publication, but its complete audit record could not be saved. The provider ID was captured; reconcile the row before any retry.'
        : 'The provider may have accepted this publication, but no definitive response was received. Reconcile it before retrying.',
      platformPublicationStatus: 'unknown',
      status: 'unknown',
    }
    if (publishedRef?.meta) {
      try {
        const current = (await payload.findByID({
          id: postId as never,
          collection: SOCIAL_POSTS_SLUG as never,
          depth: 0,
          overrideAccess: true,
        })) as unknown as { meta?: unknown }
        const currentMeta =
          current.meta && typeof current.meta === 'object'
            ? (current.meta as Record<string, unknown>)
            : {}
        data.meta = { ...currentMeta, ...publishedRef.meta }
      } catch {
        // Capturing the provider id remains sufficient to fence automatic retries.
      }
    }
    await payload.update({
      id: postId as never,
      collection: SOCIAL_POSTS_SLUG as never,
      data: data as never,
      overrideAccess: true,
    })
  } catch {
    // The original provider error remains authoritative when audit persistence fails.
  }
}
