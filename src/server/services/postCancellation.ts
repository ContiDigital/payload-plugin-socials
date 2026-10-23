import type { Payload } from 'payload'

import { SOCIAL_POSTS_SLUG } from '../../constants.js'
import { ConflictError, NotFoundError } from '../utilities/errors.js'

type CancellableRow = {
  id: number | string
  meta?: null | Record<string, unknown>
  queuedJobId?: null | string
  scheduledAt?: null | string
  status: string
}

const loadRow = async (payload: Payload, postId: number | string): Promise<CancellableRow> => {
  try {
    const row = (await payload.findByID({
      id: postId as never,
      collection: SOCIAL_POSTS_SLUG as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as CancellableRow | null
    if (row?.id !== undefined && row.id !== null) {
      return row
    }
  } catch {
    // fall through to the not-found error
  }
  throw new NotFoundError(`social-posts/${String(postId)} not found`)
}

/**
 * Cancel a post that has not reached any platform yet, through a guarded update (`status =
 * queued`, and with `minLeadSeconds` a `scheduledAt` at least that far ahead). Payload's
 * conditional update selects the matching row and then writes it, as the publish task's claim
 * does, so the guard is not atomic against that claim: a post already due can be claimed between
 * the two steps and publish although this answers cancelled. `minLeadSeconds` closes that window,
 * because the publish task never claims a post before its time. Never calls a platform adapter: a
 * published, publishing or natively scheduled post refuses with 409 and is left as it was.
 */
export const cancelQueuedSocialPost = async (args: {
  minLeadSeconds?: number
  now?: Date
  payload: Payload
  postId: number | string
  userId?: number | string
}): Promise<{ postId: number | string; status: 'cancelled' }> => {
  const row = await loadRow(args.payload, args.postId)
  if (row.status !== 'queued') {
    throw new ConflictError(
      `Only a queued post can be cancelled without touching the platform; this post is ${row.status}`,
    )
  }
  const now = args.now ?? new Date()
  const conditions: Record<string, unknown>[] = [
    { id: { equals: row.id } },
    { status: { equals: 'queued' } },
  ]
  if (args.minLeadSeconds !== undefined) {
    conditions.push({
      scheduledAt: {
        greater_than: new Date(now.getTime() + args.minLeadSeconds * 1000).toISOString(),
      },
    })
  }
  const result = (await args.payload.update({
    collection: SOCIAL_POSTS_SLUG as never,
    data: {
      meta: {
        ...(row.meta ?? {}),
        cancelledAt: now.toISOString(),
        ...(args.userId !== undefined ? { cancelledBy: args.userId } : {}),
      },
      status: 'cancelled',
    } as never,
    limit: 1,
    overrideAccess: true,
    where: { and: conditions },
  } as never)) as unknown as { docs?: unknown[] }

  if ((result.docs?.length ?? 0) !== 1) {
    const latest = await loadRow(args.payload, row.id)
    if (latest.status !== 'queued') {
      throw new ConflictError(
        `Only a queued post can be cancelled without touching the platform; this post is ${latest.status}`,
      )
    }
    throw new ConflictError(
      `The post is due within ${args.minLeadSeconds ?? 0} seconds and can no longer be cancelled safely`,
    )
  }

  if (row.queuedJobId) {
    try {
      await args.payload.jobs.cancelByID({ id: row.queuedJobId as never })
    } catch {
      // The row status is the execution fence if the queued job already started.
    }
  }
  return { postId: row.id, status: 'cancelled' }
}
