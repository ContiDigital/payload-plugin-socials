import { describe, expect, it, vi } from 'vitest'

import { PublicationPersistenceError } from '../../utilities/errors.js'
import { persistPublicationAudit } from '../publicationPersistence.js'

describe('persistPublicationAudit', () => {
  it('returns the persisted audit id', async () => {
    await expect(
      persistPublicationAudit({
        persist: vi.fn().mockResolvedValue('post_1'),
        publishedRef: { externalId: 'pin_1', platform: 'pinterest' },
      }),
    ).resolves.toBe('post_1')
  })

  it('preserves the provider reference on a persistence failure', async () => {
    const failure = persistPublicationAudit({
      persist: vi.fn().mockRejectedValue(new Error('database unavailable')),
      publishedRef: {
        externalId: 'page_post_1',
        meta: { pageId: 'page_1' },
        platform: 'facebook',
      },
    })

    await expect(failure).rejects.toBeInstanceOf(PublicationPersistenceError)
    await expect(failure).rejects.toMatchObject({
      outcome: 'unknown',
      publishedRef: {
        externalId: 'page_post_1',
        meta: { pageId: 'page_1' },
        platform: 'facebook',
      },
    })
  })
})
