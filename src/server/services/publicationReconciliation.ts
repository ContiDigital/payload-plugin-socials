import type { Payload, PayloadRequest } from 'payload'

import type { PublishedRef } from '../../types/index.js'

import { queueSocialPostPublish } from '../../plugin/jobQueue.js'
import { logAsyncOperationFailure } from '../utilities/logger.js'

const RECONCILIATION_DELAY_MS = 60_000

export const needsPublicationReconciliation = (ref: PublishedRef): boolean => {
  if (ref.platform === 'facebook') {
    return ref.meta?.scheduled === true
  }
  if (ref.platform === 'gbp') {
    const state = typeof ref.meta?.state === 'string' ? ref.meta.state : undefined
    return state !== undefined && state !== 'LIVE' && state !== 'REJECTED'
  }
  return false
}

export const queuePublicationReconciliation = async (args: {
  payload: Payload
  postId: number | string
  publishedRef: PublishedRef
  req?: PayloadRequest
}): Promise<number | string | undefined> => {
  if (!needsPublicationReconciliation(args.publishedRef)) {
    return undefined
  }
  const nativeScheduleSeconds =
    args.publishedRef.platform === 'facebook' &&
    typeof args.publishedRef.meta?.scheduledPublishTime === 'number'
      ? args.publishedRef.meta.scheduledPublishTime
      : undefined
  const waitUntil = nativeScheduleSeconds
    ? new Date(
        Math.max(Date.now() + RECONCILIATION_DELAY_MS, nativeScheduleSeconds * 1000 + 60_000),
      )
    : new Date(Date.now() + RECONCILIATION_DELAY_MS)
  try {
    return await queueSocialPostPublish({
      payload: args.payload,
      postId: args.postId,
      req: args.req,
      scheduledAt: waitUntil,
    })
  } catch (error) {
    logAsyncOperationFailure(args.payload, 'socials.publication.reconciliation.queue', error)
    return undefined
  }
}
