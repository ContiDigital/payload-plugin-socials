import type { Payload } from 'payload'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NormalizedPluginOptions,
  PublishedRef,
  SocialSourceContext,
} from '../../../../types/index.js'

import {
  PlatformApiError,
  PublicationPersistenceError,
  ValidationError,
} from '../../../utilities/errors.js'

vi.mock('../api.js', () => ({
  GBP_HOSTS: { legacyV4: 'https://mybusiness.googleapis.com' },
  gbpJson: vi.fn(),
  makeGbpRequest: vi.fn(),
}))

vi.mock('../../../assets/resolvePlatformImage.js', () => ({
  resolvePlatformImageUrl: vi.fn(),
}))

import { resolvePlatformImageUrl } from '../../../assets/resolvePlatformImage.js'
import { gbpJson, makeGbpRequest } from '../api.js'

const mockedResolve = vi.mocked(resolvePlatformImageUrl)
import {
  deleteGbpLocalPost,
  deriveGbpIdentity,
  pollGbpLocalPostState,
  publishGbpLocalPost,
  reconcileGbpLocalPostState,
} from '../publish.js'

const mockedGbpJson = vi.mocked(gbpJson)
const mockedRequest = vi.mocked(makeGbpRequest)

const options = {
  copyOverrides: {},
  platforms: { gbp: { enabled: true } },
} as unknown as NormalizedPluginOptions

const ctx = (over: Partial<SocialSourceContext> = {}): SocialSourceContext => ({
  baseDescription: 'Visit our showroom.',
  baseTitle: 'Spring Showcase',
  images: [{ role: 'main', url: 'https://cdn.example.com/main.jpg' }],
  link: 'https://example.com/events/spring',
  sourceId: '1',
  sourceKind: 'product',
  ...over,
})

const LOCATION = 'accounts/123/locations/456'

const schedule = {
  endDate: { day: 7, month: 6, year: 2027 },
  startDate: { day: 1, month: 6, year: 2027 },
}

interface MockPayload {
  create: ReturnType<typeof vi.fn>
  find: ReturnType<typeof vi.fn>
  logger: undefined
  update: ReturnType<typeof vi.fn>
}

let payload: MockPayload
const asPayload = (p: MockPayload): Payload => p as unknown as Payload

const publishBody = (): Record<string, unknown> =>
  JSON.parse((mockedGbpJson.mock.calls[0][3] as { body: string }).body) as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  // Default: pass image URLs through unchanged (no conversion). The idempotency
  // key must derive from the original URL regardless of this.
  mockedResolve.mockImplementation(({ imageUrl }) =>
    Promise.resolve({ converted: false, url: imageUrl }),
  )
  payload = {
    create: vi.fn().mockResolvedValue({ id: 'row_new' }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
    logger: undefined,
    update: vi.fn().mockResolvedValue({ id: 'row_existing' }),
  }
  mockedGbpJson.mockResolvedValue({
    name: 'accounts/123/locations/456/localPosts/p1',
    searchUrl: 'https://posts.gle/abc',
    state: 'LIVE',
  })
})

describe('publishGbpLocalPost — location + topic validation', () => {
  it('rejects a malformed locationResourceName', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: { locationResourceName: 'not/a/location' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/accounts\/\{a\}\/locations\/\{l\}/)
  })

  it('requires a non-empty summary', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx({ baseDescription: '', baseTitle: '' }),
        input: { locationResourceName: LOCATION },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/summary is required/)
  })

  it('requires an event block for EVENT and OFFER', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: { locationResourceName: LOCATION, topicType: 'EVENT' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/event block/)
  })

  it('rejects an event whose end is before its start', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: {
          event: {
            schedule: {
              endDate: { day: 1, month: 6, year: 2027 },
              startDate: { day: 7, month: 6, year: 2027 },
            },
            title: 'Sale',
          },
          locationResourceName: LOCATION,
          topicType: 'EVENT',
        },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/end must be after/)
  })

  it('rejects an OFFER with a callToAction and requires an offer block', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: {
          callToAction: { actionType: 'SHOP', url: 'https://x' },
          event: { schedule, title: 'Sale' },
          locationResourceName: LOCATION,
          topicType: 'OFFER',
        },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/cannot include callToAction/)

    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: {
          event: { schedule, title: 'Sale' },
          locationResourceName: LOCATION,
          topicType: 'OFFER',
        },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/require an offer block/)
  })

  it('rejects an ALERT without an alertType and one carrying media', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: { locationResourceName: LOCATION, topicType: 'ALERT' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/require alertType/)

    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: {
          alertType: 'COVID_19',
          imageUrl: 'https://cdn/x.jpg',
          locationResourceName: LOCATION,
          topicType: 'ALERT',
        },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/cannot include media/)
  })

  it('requires a callToAction url unless the action is CALL', async () => {
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: { callToAction: { actionType: 'SHOP' }, locationResourceName: LOCATION },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toThrow(/callToAction.url is required/)
  })
})

describe('publishGbpLocalPost — body assembly', () => {
  it('captures the Local Post name and fences retries when audit persistence fails', async () => {
    payload.create.mockRejectedValue(new Error('database unavailable'))

    const publication = publishGbpLocalPost({
      ctx: ctx(),
      input: { locationResourceName: LOCATION, summary: 'Hello' },
      options,
      payload: asPayload(payload),
    })

    await expect(publication).rejects.toBeInstanceOf(PublicationPersistenceError)
    await expect(publication).rejects.toMatchObject({
      outcome: 'unknown',
      publishedRef: {
        externalId: 'accounts/123/locations/456/localPosts/p1',
        platform: 'gbp',
      },
    })
    expect(mockedGbpJson).toHaveBeenCalledOnce()
  })

  it('publishes a STANDARD post with media and persists the LIVE state', async () => {
    const result = await publishGbpLocalPost({
      ctx: ctx(),
      input: { imageUrl: 'https://cdn/x.jpg', locationResourceName: LOCATION, summary: 'Hello' },
      options,
      payload: asPayload(payload),
    })
    expect(result.state).toBe('LIVE')
    expect(result.publishedRef.externalId).toBe('accounts/123/locations/456/localPosts/p1')
    const body = publishBody()
    expect(body.topicType).toBe('STANDARD')
    expect(body.summary).toBe('Hello')
    expect(body.media).toEqual([{ mediaFormat: 'PHOTO', sourceUrl: 'https://cdn/x.jpg' }])
    expect(payload.create.mock.calls[0][0].data.platformPublicationStatus).toBe('published')
    expect(payload.create.mock.calls[0][0].data.destinationId).toBe(LOCATION)
    expect(payload.create.mock.calls[0][0].data.destination).not.toHaveProperty('id')
  })

  it('derives the idempotency key from the ORIGINAL image URL when autoConvert rewrites it', async () => {
    // autoConvert rewrites the outbound URL...
    mockedResolve.mockResolvedValue({
      converted: true,
      format: 'jpeg',
      url: 'https://cdn/x-converted.jpg',
    })
    await publishGbpLocalPost({
      ctx: ctx(),
      input: { imageUrl: 'https://cdn/x.jpg', locationResourceName: LOCATION, summary: 'Hello' },
      options,
      payload: asPayload(payload),
    })
    // ...the API body carries the CONVERTED URL...
    expect(publishBody().media).toEqual([
      { mediaFormat: 'PHOTO', sourceUrl: 'https://cdn/x-converted.jpg' },
    ])
    // ...but the persisted idempotency key equals the one derived from the
    // ORIGINAL input (what the reservation layer computes), so conversion cannot
    // split them into two rows.
    const persistedKey = String(payload.create.mock.calls[0][0].data.idempotencyKey)
    const originalKey = deriveGbpIdentity(ctx(), {
      imageUrl: 'https://cdn/x.jpg',
      locationResourceName: LOCATION,
      summary: 'Hello',
    }).idempotencyKey
    expect(persistedKey).toBe(originalKey)
  })

  it('includes the event block for an EVENT post', async () => {
    await publishGbpLocalPost({
      ctx: ctx(),
      input: {
        event: { schedule, title: 'Spring Sale' },
        locationResourceName: LOCATION,
        topicType: 'EVENT',
      },
      options,
      payload: asPayload(payload),
    })
    const body = publishBody()
    expect(body.topicType).toBe('EVENT')
    expect((body.event as { title: string }).title).toBe('Spring Sale')
  })

  it('includes the offer block and omits callToAction for an OFFER post', async () => {
    await publishGbpLocalPost({
      ctx: ctx(),
      input: {
        event: { schedule, title: 'BOGO' },
        locationResourceName: LOCATION,
        offer: { couponCode: 'BOGO25' },
        topicType: 'OFFER',
      },
      options,
      payload: asPayload(payload),
    })
    const body = publishBody()
    expect(body.topicType).toBe('OFFER')
    expect((body.offer as { couponCode: string }).couponCode).toBe('BOGO25')
    expect(body.callToAction).toBeUndefined()
  })

  it('defaults the persisted state to PROCESSING when the API omits it', async () => {
    mockedGbpJson.mockResolvedValue({ name: 'accounts/123/locations/456/localPosts/p2' })
    const result = await publishGbpLocalPost({
      ctx: ctx(),
      input: { locationResourceName: LOCATION, summary: 'Hi' },
      options,
      payload: asPayload(payload),
    })
    expect(result.state).toBe('PROCESSING')
    expect(payload.create.mock.calls[0][0].data.platformPublicationStatus).toBe('publishing')
    expect(payload.create.mock.calls[0][0].data.publishedAt).toBeUndefined()
    expect(payload.create.mock.calls[0][0].data.nextRetryAt).toEqual(expect.any(String))
  })

  it('persists a REJECTED state before returning the provider error', async () => {
    mockedGbpJson.mockResolvedValue({
      name: 'accounts/123/locations/456/localPosts/rejected',
      state: 'REJECTED',
    })

    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: { locationResourceName: LOCATION, summary: 'Hi' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toMatchObject({ statusCode: 422, upstreamCode: 'REJECTED' })
    expect(payload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          platformPublicationStatus: 'failed',
          status: 'failed',
        }),
      }),
    )
  })

  it('throws when the API returns no resource name', async () => {
    mockedGbpJson.mockResolvedValue({ state: 'LIVE' })
    await expect(
      publishGbpLocalPost({
        ctx: ctx(),
        input: { locationResourceName: LOCATION, summary: 'Hi' },
        options,
        payload: asPayload(payload),
      }),
    ).rejects.toBeInstanceOf(PlatformApiError)
  })

  it('short-circuits when a published row already exists', async () => {
    payload.find.mockResolvedValue({
      docs: [
        {
          id: 'row_x',
          externalId: 'accounts/123/locations/456/localPosts/old',
          status: 'published',
        },
      ],
    })
    const result = await publishGbpLocalPost({
      ctx: ctx(),
      input: { locationResourceName: LOCATION, summary: 'Hi' },
      options,
      payload: asPayload(payload),
    })
    expect(result.alreadyExisted).toBe(true)
    expect(mockedGbpJson).not.toHaveBeenCalled()
  })
})

describe('pollGbpLocalPostState', () => {
  it('returns immediately once the state leaves PROCESSING', async () => {
    mockedGbpJson.mockResolvedValue({
      name: 'n',
      searchUrl: 'https://posts.gle/live',
      state: 'LIVE',
    })
    const result = await pollGbpLocalPostState({
      options,
      payload: asPayload(payload),
      postName: 'accounts/123/locations/456/localPosts/p1',
    })
    expect(result).toEqual({ searchUrl: 'https://posts.gle/live', state: 'LIVE' })
  })

  it('returns the last state when the deadline elapses', async () => {
    mockedGbpJson.mockResolvedValue({ name: 'n', state: 'PROCESSING' })
    const result = await pollGbpLocalPostState({
      maxWaitMs: 0,
      options,
      payload: asPayload(payload),
      postName: 'accounts/123/locations/456/localPosts/p1',
    })
    expect(result.state).toBe('PROCESSING')
  })
})

describe('reconcileGbpLocalPostState', () => {
  it('transitions a processing row to published when the provider reports LIVE', async () => {
    mockedGbpJson.mockResolvedValue({ searchUrl: 'https://posts.gle/live', state: 'LIVE' })

    const result = await reconcileGbpLocalPostState({
      options,
      payload: asPayload(payload),
      postId: 'row_1',
      postName: 'accounts/123/locations/456/localPosts/p1',
    })

    expect(result).toEqual({ pending: false, state: 'LIVE' })
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalUrl: 'https://posts.gle/live',
          nextRetryAt: null,
          platformPublicationStatus: 'published',
          publishedAt: expect.any(String),
          status: 'published',
        }),
      }),
    )
  })

  it('keeps an unresolved provider state pending with another check scheduled', async () => {
    mockedGbpJson.mockResolvedValue({ state: 'SCHEDULED' })

    const result = await reconcileGbpLocalPostState({
      options,
      payload: asPayload(payload),
      postId: 'row_1',
      postName: 'accounts/123/locations/456/localPosts/p1',
    })

    expect(result).toEqual({ pending: true, state: 'SCHEDULED' })
    expect(payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextRetryAt: expect.any(String),
          platformPublicationStatus: 'publishing',
          status: 'publishing',
        }),
      }),
    )
  })
})

describe('deleteGbpLocalPost', () => {
  const ref = (over: Partial<PublishedRef> = {}): PublishedRef => ({
    externalId: 'accounts/123/locations/456/localPosts/p1',
    platform: 'gbp',
    ...over,
  })

  it('rejects a publishedRef for another platform', async () => {
    await expect(
      deleteGbpLocalPost({
        options,
        payload: asPayload(payload),
        publishedRef: ref({ platform: 'pinterest' }),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('is a no-op without an external id', async () => {
    await deleteGbpLocalPost({
      options,
      payload: asPayload(payload),
      publishedRef: ref({ externalId: undefined }),
    })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('deletes upstream and leaves the endpoint to own the local transition', async () => {
    mockedRequest.mockResolvedValue({ ok: true, status: 200 } as unknown as Response)
    payload.find.mockResolvedValue({ docs: [{ id: 'row_1' }] })
    await deleteGbpLocalPost({ options, payload: asPayload(payload), publishedRef: ref() })
    expect(payload.update).not.toHaveBeenCalled()
  })

  it('throws on a non-404 failure', async () => {
    mockedRequest.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('error'),
    } as unknown as Response)
    await expect(
      deleteGbpLocalPost({ options, payload: asPayload(payload), publishedRef: ref() }),
    ).rejects.toBeInstanceOf(PlatformApiError)
  })
})
