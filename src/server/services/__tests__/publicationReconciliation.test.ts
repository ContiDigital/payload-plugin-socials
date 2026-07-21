import type { Payload } from 'payload'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublishedRef } from '../../../types/index.js'

vi.mock('../../../plugin/jobQueue.js', () => ({ queueSocialPostPublish: vi.fn() }))
vi.mock('../../utilities/logger.js', () => ({ logAsyncOperationFailure: vi.fn() }))

import { queueSocialPostPublish } from '../../../plugin/jobQueue.js'
import { logAsyncOperationFailure } from '../../utilities/logger.js'
import {
  needsPublicationReconciliation,
  queuePublicationReconciliation,
} from '../publicationReconciliation.js'

const payload = {} as Payload
const now = new Date('2026-07-20T12:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.mocked(queueSocialPostPublish).mockResolvedValue('job-1')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('needsPublicationReconciliation', () => {
  it.each([
    [{ externalId: 'fb-1', meta: { scheduled: true }, platform: 'facebook' }, true],
    [{ externalId: 'fb-1', meta: { scheduled: false }, platform: 'facebook' }, false],
    [{ externalId: 'gbp-1', meta: { state: 'PROCESSING' }, platform: 'gbp' }, true],
    [{ externalId: 'gbp-1', meta: { state: 'LIVE' }, platform: 'gbp' }, false],
    [{ externalId: 'gbp-1', meta: { state: 'REJECTED' }, platform: 'gbp' }, false],
    [{ externalId: 'gbp-1', platform: 'gbp' }, false],
    [{ externalId: 'pin-1', platform: 'pinterest' }, false],
  ] satisfies Array<[PublishedRef, boolean]>)('classifies %o as %s', (ref, expected) => {
    expect(needsPublicationReconciliation(ref)).toBe(expected)
  })
})

describe('queuePublicationReconciliation', () => {
  it('does not enqueue publications that are already terminal', async () => {
    await expect(
      queuePublicationReconciliation({
        payload,
        postId: 'post-1',
        publishedRef: { externalId: 'pin-1', platform: 'pinterest' },
      }),
    ).resolves.toBeUndefined()
    expect(queueSocialPostPublish).not.toHaveBeenCalled()
  })

  it('enqueues GBP reconciliation one minute later', async () => {
    await expect(
      queuePublicationReconciliation({
        payload,
        postId: 'post-1',
        publishedRef: {
          externalId: 'accounts/a/locations/l/localPosts/p',
          meta: { state: 'PROCESSING' },
          platform: 'gbp',
        },
      }),
    ).resolves.toBe('job-1')

    expect(queueSocialPostPublish).toHaveBeenCalledWith({
      payload,
      postId: 'post-1',
      req: undefined,
      scheduledAt: new Date('2026-07-20T12:01:00.000Z'),
    })
  })

  it('waits until one minute after a future Facebook native schedule', async () => {
    const scheduledPublishTime = Math.floor(now.getTime() / 1000) + 3_600
    await queuePublicationReconciliation({
      payload,
      postId: 42,
      publishedRef: {
        externalId: 'page_post',
        meta: { scheduled: true, scheduledPublishTime },
        platform: 'facebook',
      },
    })

    expect(queueSocialPostPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledAt: new Date('2026-07-20T13:01:00.000Z'),
      }),
    )
  })

  it('uses the minimum delay when a Facebook schedule is absent or already due', async () => {
    await queuePublicationReconciliation({
      payload,
      postId: 42,
      publishedRef: {
        externalId: 'page_post',
        meta: { scheduled: true, scheduledPublishTime: Math.floor(now.getTime() / 1000) - 60 },
        platform: 'facebook',
      },
    })

    expect(queueSocialPostPublish).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: new Date('2026-07-20T12:01:00.000Z') }),
    )
  })

  it('logs queue failures and leaves the sweep as the fallback', async () => {
    const error = new Error('queue unavailable')
    vi.mocked(queueSocialPostPublish).mockRejectedValue(error)

    await expect(
      queuePublicationReconciliation({
        payload,
        postId: 'post-1',
        publishedRef: {
          externalId: 'gbp-1',
          meta: { state: 'SCHEDULED' },
          platform: 'gbp',
        },
      }),
    ).resolves.toBeUndefined()
    expect(logAsyncOperationFailure).toHaveBeenCalledWith(
      payload,
      'socials.publication.reconciliation.queue',
      error,
    )
  })
})
