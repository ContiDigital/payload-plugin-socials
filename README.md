# payload-plugin-socials

Multi-platform organic social publishing for [Payload CMS](https://payloadcms.com) 3.

<img width="1542" height="1169" alt="The multi-platform social composer inside the Payload admin, with per-platform tabs, media selection, and live preview" src="https://github.com/user-attachments/assets/1e00ac76-42b9-4574-a2d7-5a8b1674d045" />

Compose, preview, template, schedule, publish, reconcile, and measure posts across Pinterest, Instagram Business, Facebook Pages, and Google Business Profile. The plugin provides real API adapters, encrypted credential storage, idempotency controls, a durable audit trail, and Payload-native admin surfaces. It does not provide a copy-and-paste fallback. Its editorial defaults can optionally use the documented commerce-style metadata convention, while transformations, `copyOverrides`, and templates let every host replace that copy without embedding application-specific catalog logic.

**Running in production at [Fine's Gallery](https://www.finesgallery.com).** This plugin was built for, and extracted from, Fine's Gallery, a luxury bronze and marble retailer with nearly 1M annual users, where it is the social publishing control center.

**The composer, end to end.** Publishing a live product post directly from the Payload admin: open the record's Socials tab, pick the media, review the generated per-platform copy in each channel tab, preview, and publish. The post is live on the real platform seconds later, with the publication recorded in the plugin's audit collection.

https://github.com/user-attachments/assets/3e05266b-7870-494b-b679-dfff6a08bfaf

**Fully agent-drivable.** Every capability in that composer is also a deterministic, authenticated HTTP surface (discovery, validation, multi-channel publish, history, deletion, and reconciliation), so an AI agent can run your social publishing without the plugin embedding any model. Here, an agent composes and publishes a post through the same API a human would use, with idempotent retries and a durable audit trail guarding every write. See the [agent and headless integration guide](./docs/agent-integration.md).

https://github.com/user-attachments/assets/67e33cd7-8b9e-4763-95b7-06cb7c7b40bc

## What it adds

- A per-record Socials composer injected into the collections you choose.
- A standalone multi-channel composer at `/admin/socials`.
- Plugin-owned `social-posts` and `social-templates` collections.
- A hidden `socials-connections` global with AES-256-GCM encrypted tokens and key rotation.
- Pinterest image/video Pins, Instagram images/Reels/Stories/Carousels, Facebook link/photo/multi-photo/video posts, and GBP Standard/Event/Offer/Alert Local Posts.
- Destination discovery, preview, server-side validation, publication, history, deletion, reconciliation, insights, OAuth, and webhook endpoints.
- Payload Jobs task definitions for scheduled publication, retries, insights, and credential refresh. The host controls when workers run.
- Optional image-format preflight, deterministic JPEG rendition generation, and bounded, uncropped rendition normalization.

The host supplies source resolvers, authorization, credentials, the encryption key, and any scheduling trigger.

## Requirements

- Payload CMS `^3.84.1`
- Node.js `>=22.12.0`
- React and React DOM `^19.0.0` for Payload admin surfaces
- pnpm 9 or 10 when working in this repository
- `sharp` only when `assets.autoConvert` is enabled
- A public HTTPS origin for OAuth callbacks and provider-fetchable media

```bash
pnpm add payload-plugin-socials
```

## Platform readiness

| Platform                | Implementation                                                                                                           | Release guidance                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Pinterest               | OAuth, board discovery/CRUD, image and video Pins, insights, delete                                                      | **Live in production at Fine's Gallery**; run a controlled canary with your own credentials                                |
| Facebook Pages          | System-user or OAuth credentials; link, photo, multi-photo, video, native scheduling, insights, delete                   | **Live in production at Fine's Gallery**; Meta app must be Live for public visibility, then verify with a non-role account |
| Instagram Business      | System-user or OAuth credentials; image, Reels, Stories, Carousel, insights                                              | **Live in production at Fine's Gallery**; Meta app must be Live; remove upstream media in-app and reconcile locally        |
| Google Business Profile | OAuth or service account; account/location discovery; Standard, Event, Offer, provider-permitted Alert; insights, delete | Experimental: API-complete and contract-tested, but requires Google Basic API Access and has not yet run a live canary     |

Provider approval, quotas, and policy compliance remain the host's responsibility. See the platform guides before enabling an adapter.

> **Meta Development mode is role-only.** Facebook or Instagram publishing can return a successful object ID while the test content is visible only to app-role users such as administrators, developers, and testers. Public publishing requires the app/use case to be **Live** with the required permission access. Remove unwanted test posts before switching modes, then validate a canary from a logged-out or non-role account. See [Meta App Modes](https://developers.facebook.com/documentation/development/build-and-test/app-modes) and the [installation guide](./docs/installation.md#meta-development-mode-is-not-public-publishing).

## Minimal configuration

This example maps an illustrative `content` collection to an `entry` source
kind. Replace the collection, fields, and source-kind string with concepts from
your own schema; source kinds are host-defined.

```ts
import { buildConfig } from 'payload'
import { payloadPluginSocials } from 'payload-plugin-socials'

export default buildConfig({
  plugins: [
    payloadPluginSocials({
      encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!,

      authorize: async ({ req, scope }) => {
        const role = req.user?.role
        if (!role) return false
        return scope === 'admin'
          ? ['admin', 'owner'].includes(role)
          : ['admin', 'owner', 'editor'].includes(role)
      },

      sources: {
        entry: async ({ payload, id }) => {
          const entry = await payload.findByID({ collection: 'content', id, depth: 1 })
          return {
            sourceId: String(entry.id),
            sourceKind: 'entry',
            baseTitle: entry.title,
            baseDescription: entry.summary ?? '',
            link: `${process.env.PUBLIC_URL}/content/${entry.slug}`,
            images: [entry.hero, ...(entry.media ?? [])].flatMap((asset, index) =>
              typeof asset === 'object' && asset?.url
                ? [{ role: index === 0 ? 'main' : 'detail', url: asset.url }]
                : [],
            ),
            metadata: { audience: entry.audience, tags: entry.tags },
          }
        },
      },

      admin: {
        injectInto: [{ collection: 'content', sourceKind: 'entry' }],
        mode: 'both',
      },

      platforms: {
        pinterest: {
          clientId: process.env.PINTEREST_APP_ID!,
          clientSecret: process.env.PINTEREST_APP_SECRET!,
          enabled: true,
          redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
        },
      },
    }),
  ],
})
```

After adding or upgrading the plugin, generate the host-owned artifacts and inspect the migration before applying it:

```bash
pnpm payload generate:types
pnpm payload generate:importmap
pnpm payload migrate:create socials
pnpm payload migrate
```

The plugin never creates or runs migration files.

## Configuration

Required options:

| Option          | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `encryptionKey` | A 32-byte Buffer, 64-character hex string, or valid base64 key used for credential encryption |
| `authorize`     | Host authorization for `publisher` and `admin` scopes                                         |
| `sources`       | At least one source-kind-to-resolver mapping                                                  |
| `platforms`     | At least one declared platform; each adapter also has an `enabled` flag                       |

```ts
payloadPluginSocials({
  encryptionKey,
  authorize,
  sources,
  platforms: {
    pinterest?: {
      enabled: boolean
      clientId?: string
      clientSecret?: string
      redirectUri?: string
      environment?: 'production' | 'sandbox'
      scopes?: string[] // defaults to the plugin's required scope set
      allowedVideoHosts?: string[] // required to publish video Pins
      videoUploadTimeoutMs?: number
    }
    facebook?: {
      enabled: boolean
      appId?: string
      appSecret?: string
      redirectUri?: string
      systemUserAccessToken?: string
      apiVersion?: string // e.g. 'v25.0'
      scopes?: string[]
    }
    instagram?: {
      enabled: boolean
      appId?: string
      appSecret?: string
      redirectUri?: string
      systemUserAccessToken?: string
      apiVersion?: string // e.g. 'v25.0'
      scopes?: string[]
    }
    gbp?: {
      enabled: boolean
      clientId?: string
      clientSecret?: string
      redirectUri?: string
      serviceAccount?: { clientEmail: string; privateKey: string; impersonate?: string }
    }
  }

  authCollection?: string // auto-detected only when the host has exactly one auth collection
  admin?: {
    mode?: 'route' | 'dashboard' | 'both' | 'headless'
    route?: `/${string}`
    navLabel?: string
    injectInto?: Array<{
      collection: string
      sourceKind: string
      label?: string
      tabPosition?: 'append' | 'before-last' | number
    }>
    mediaLibrary?: {
      collectionSlugs?: string[]
      filterOptions?: Partial<Record<string, Where | boolean>>
    }
  }
  api?: { basePath?: `/${string}` }
  transformations?: SocialsTransformations
  copyOverrides?: SocialsCopyOverrides
  assets?: {
    preflight?: boolean
    autoConvert?: boolean
    renditionCollection?: string
    renditionData?: Record<string, unknown>
    normalize?: boolean
    jpegQuality?: number
    maxSourceImageBytes?: number
    maxConcurrentConversions?: number
    remoteFetchTimeoutMs?: number
    trustedRemoteHosts?: string[]
  }
  scheduling?: {
    internalApiKey?: string
    queue?: string
    autoRun?: {
      cron?: string
      insightsRefreshCron?: string
      connectionRefreshCron?: string
    }
    sweepBatchSize?: number
    drainBatchSize?: number
    connectionRefreshWindowSeconds?: number
    insightsRefreshWindowSeconds?: number
  }
  rateLimit?: SocialsRateLimitConfig
  coordination?: SocialsCoordinationConfig
  webhooks?: SocialsWebhookConfig
  previousEncryptionKeys?: readonly (string | Buffer)[]
  testMode?: boolean
  disabled?: boolean
})
```

`admin.mediaLibrary` scopes the "Add from media library" drawer in both composers to specific upload collections and, through serializable per-collection `Where` filters, to specific documents (for example, public images only). Without it the drawer lists every upload collection.

If a host has multiple auth-enabled collections, `authCollection` is required so the optional `publishedBy` relationship has an unambiguous target. A host with no auth collection may omit it; request authorization still remains mandatory.

The plugin supports one `payloadPluginSocials(...)` instance per Payload config and throws during config construction if a second instance is applied. Combine all enabled platforms and source resolvers in that instance.

With `disabled: true`, the plugin keeps its two collections and connection global in the schema, but hides them, denies access, removes hooks, and registers no endpoints, tasks, or admin surfaces. Keep the same `sources` keys and `authCollection` as enabled mode so migrations remain stable; encryption and platform credentials may be omitted.

## Source resolvers

A resolver converts a host document into the intentionally small, channel-neutral `SocialSourceContext`:

```ts
type SourceContextResolver = (args: {
  id: number | string
  payload: Payload
  req?: PayloadRequest
}) => Promise<SocialSourceContext>

type SocialSourceContext = {
  sourceId: string
  sourceKind: string
  baseTitle: string
  baseDescription: string
  link: string
  images: Array<{
    url: string
    role: string
    width?: number
    height?: number
    format?: 'avif' | 'bmp' | 'gif' | 'jpeg' | 'png' | 'tiff' | 'webp'
    alt?: string
  }>
  videos?: Array<{ url: string; coverImageUrl?: string }>
  modelLabel?: string | null
  metadata?: Record<string, unknown>
  // Optional per-platform hints the default copy builders read.
  hints?: { pinterestSegments?: string[]; instagramHashtags?: string[] }
}
```

Use a stable string `sourceId`, keep domain fields in `metadata`, and return durable public HTTPS media URLs. Provider fetchers cannot use localhost, private networks, or short-lived signed URLs. Exact `metadata.*` paths are available to templates.

## Copy and templates

Copy resolves in this order:

1. A template selected for the post.
2. The default template for the source kind.
3. A source-kind or `'*'` config transformation.
4. `copyOverrides`.
5. Built-in defaults.

Transform strings use the safe `{{ path | filter }}` renderer. Supported filters are `upper`, `lower`, `trim`, `truncate:N`, and `default:text`.

```ts
transformations: {
  entry: {
    pinterestTitle: '{{ title }} | {{ metadata.audience | default:Featured }}',
    instagramCaption: '{{ title }}\n\n{{ description | truncate:2000 }}',
  },
  '*': { facebookMessage: '{{ title }}\n\n{{ description | truncate:400 }}' },
}
```

## Publication identity and retries

The default identity is derived from the platform, source, destination, format where relevant, and primary asset. Copy edits change the audit `sourceHash`, not the default identity. A previously published identity returns its existing reference.

Use `publicationKey` in a platform input when the caller owns a stable logical campaign identity. Use `idempotencyKeyOverride` only to adopt a known legacy 64-character SHA-256 key during migration. Reusing either value intentionally addresses the same audit row.

The plugin retries safe reads and explicitly retryable throttling responses. It does not blindly replay an unsafe provider `POST` when its typed transport result cannot rule out provider acceptance. A provider success followed by local audit-persistence failure is fenced the same way, with the returned provider ID captured on the row whenever the database is reachable. The row becomes `unknown` (or remains non-reclaimable as `publishing` if the fence write also fails) and automatic publication retry is suppressed until an operator verifies the provider and calls:

```http
POST /api/socials/posts/{postId}/resolve
Content-Type: application/json

{ "outcome": "published", "externalId": "provider-id", "externalUrl": "https://..." }
```

or `{ "outcome": "not-published" }`. This prevents retry logic from creating duplicate public posts when the provider accepted a request but its response was lost.

## Scheduling

The plugin defines the jobs and their tasks; **the host owns the trigger and runs the workers** (the same contract as the sibling Merchant Center plugin). The plugin never writes to your `jobs.autoRun`. Choose any of these, and mix freely:

- **Native Payload Jobs.** Set `scheduling.autoRun` crons and the plugin attaches Payload task-level `schedule` entries to its sweep/insights/connection tasks. Run a Payload Jobs worker that handles schedules and drains the queue: configure your own `jobs.autoRun` in the Payload config, or call `payload.jobs.handleSchedules()` + `payload.jobs.run()` on a cron.
- **External cron.** Have EventBridge, Vercel cron, a GitHub Action, or plain cron `POST /api/socials/internal/jobs/sweep` (and `/insights/refresh`, `/connections/refresh`) with the `X-Socials-API-Key`. No Payload worker required. This is what Fine's Gallery runs in production.
- **Long-running worker.** Call `sweepDueSocialPosts(payload, normalizedOptions)` and `runQueuedSocialsJobs(payload, normalizedOptions)` in a loop.

Scheduled _publishes_ (`scheduledAt` on a source publish) are enqueued with `waitUntil` immediately and drained by any of the above. The periodic insights/connection/sweep tasks fire under the native mode (via task `schedule`) or when you call the internal endpoints / helpers.

The queue name is independent of cron configuration. If you select a custom queue, use it in both places:

```ts
export default buildConfig({
  jobs: {
    // Host-owned worker cadence. This drains the queue and handles task schedules.
    autoRun: [{ cron: '* * * * *', queue: 'operator-socials' }],
  },
  plugins: [
    payloadPluginSocials({
      // ...credentials, platforms, sources, authorize...
      scheduling: {
        queue: 'operator-socials',
        autoRun: {
          cron: '*/5 * * * *',
          insightsRefreshCron: '0 * * * *',
          connectionRefreshCron: '0 3 * * *',
        },
      },
    }),
  ],
})
```

Scheduling uses a per-revision token, rechecks the due time in the task, and cancels superseded Payload jobs when possible. The token and status checks remain the correctness fence if cancellation races with a worker.

Facebook's `scheduledPublishTime` is provider-native scheduling. The generic source-publish `scheduledAt` is plugin scheduling. Accepted GBP posts and native Facebook schedules remain pending until reconciliation confirms the provider state; sweep jobs provide the backstop.

## Image safety

With preflight enabled, remote image inspection is HTTPS-only, redirect-bounded, time-bounded, and streamed under a processing cap (`assets.maxSourceImageBytes`, 25 MiB by default). Every redirect hostname is resolved and validated, and the HTTPS connection is pinned to that validated address while preserving the hostname for TLS SNI and certificate verification. DNS names resolving to local, private, link-local, documentation, or otherwise non-public IP ranges are rejected. `trustedRemoteHosts` is an explicit exact-host bypass for a host-controlled private media origin and should normally remain empty; those connections are still DNS-pinned.

Image detection uses file signatures, not URL extensions, so extensionless CDN URLs are supported. With preflight enabled, an unreadable or unrecognized signature fails closed instead of passing an uninspected asset to a provider. Set `assets.preflight: false` only when the host deliberately accepts that pass-through behavior.

When `autoConvert` is enabled, configure a dedicated public upload collection with no `formatOptions`; the plugin writes deterministic JPEG renditions there. Idempotency continues to use the original media URL. `assets.renditionData` supplies field values the rendition collection requires, such as alt text.

`assets.normalize` extends conversion to every image, including formats the platform already accepts. Each rendition applies EXIF orientation, flattens transparency to white, converts to sRGB, strips metadata and is fitted onto a per-platform canvas without cropping: Facebook keeps the photograph's own proportions within 2048 pixels and is never enlarged, Instagram stories use a 1080 by 1920 canvas, and every other image is padded onto a 1080 pixel square so a carousel of mixed ratios publishes intact. Sources are decoded within a 64 megapixel budget and the encoded result must fit the platform's byte limit. Renditions are cached per source URL, platform, presentation and quality. Raise `maxSourceImageBytes` when originals are large; `maxConcurrentConversions` (default 1) bounds how many conversions a process runs at once, which matters for multi-photo and carousel publishes.

## Deferred publishing

Publishing can outlive an HTTP request when a host runs provider calls on a worker. The composers send `X-Socials-Publish-Async: 1` with every publish request. A host that defers the request may answer `202 Accepted` with `X-Socials-Publish-Status: pending`, a `Location` header pointing at `{basePath}/requests/{id}` (same origin, numeric id, no query string) and an optional `Retry-After` in seconds. The composer keeps the publish control busy and polls that URL with `GET` until a non-pending response arrives, then handles it exactly as it would the original publish response, including provider errors. The publish request is submitted once; polling only reads, is clamped to one to five seconds between attempts and gives up after ten minutes with a message that points the operator at post history. Hosts that answer synchronously need no changes, and an unrelated `202` without the status header is passed through untouched. The header names and path segment are exported as `SOCIAL_PUBLISH_ASYNC_HEADER`, `SOCIAL_PUBLISH_STATUS_HEADER`, `SOCIAL_PUBLISH_STATUS_PENDING` and `SOCIAL_PUBLISH_REQUESTS_SEGMENT`.

## Access and secrets

Every API and admin surface calls the host's `authorize` function. `publisher` covers compose, preview, publish, history, delete, and reconciliation. `admin` covers connection and template administration.

Stored tokens use authenticated AES-256-GCM envelopes. Keep `encryptionKey` stable and identical across all instances. During rotation, make the new key primary and temporarily provide old keys in `previousEncryptionKeys`; successfully read envelopes are rewritten with the primary key. Secret-bearing fields are redacted before plugin logs reach the host logger.

For multi-process deployments, provide `coordination.withLock` for credential rotation and `coordination.acquireRequestLease` for fleet-wide outbound quotas. The built-in limiter is process-local.

## Primary endpoints

Paths below are relative to Payload's `/api` route and the default `/socials` plugin base.

| Method     | Path                                                                                    | Access                    |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------- |
| GET        | `/socials/health`                                                                       | Public, non-secret status |
| GET        | `/socials/access`                                                                       | Capability probe          |
| GET        | `/socials/connections`                                                                  | Admin                     |
| POST / GET | `/socials/{platform}/oauth/start`, `/oauth/callback`                                    | Admin / OAuth state       |
| POST       | `/socials/{platform}/disconnect`                                                        | Admin                     |
| GET / POST | `/socials/{platform}/{kind}/{id}/preview`, `/validate`                                  | Publisher                 |
| POST       | `/socials/{platform}/{kind}/{id}/publish`                                               | Publisher                 |
| GET        | `/socials/{platform}/{kind}/{id}/history`                                               | Publisher                 |
| POST       | `/socials/compose/publish`                                                              | Publisher                 |
| DELETE     | `/socials/posts/{postId}`                                                               | Publisher                 |
| POST       | `/socials/posts/{postId}/resolve`                                                       | Publisher                 |
| GET        | `/socials/pinterest/boards`, `/facebook/pages`, `/instagram/accounts`, `/gbp/locations` | Publisher                 |
| POST       | `/socials/templates/preview`                                                            | Admin                     |
| POST       | `/socials/internal/jobs/sweep`, `/jobs/run`                                             | Scheduler API key         |

The source preview route is `GET` for UI convenience; validate and all mutations are `POST`. The internal API key is separate from Payload user authentication.

## Programmatic use

HTTP is the stable integration surface for headless services. The low-level server helper is also exported when host code already has the normalized options and source context:

```ts
const result = await composeAndPublish({
  ctx,
  options: normalizedOptions,
  payload,
  req,
  targets: [
    {
      platform: 'pinterest',
      input: { boardId: 'board-id', imageUrl: ctx.images[0]?.url },
    },
  ],
})
```

`normalizePluginOptions` is exported for worker entrypoints that construct the same host configuration outside Payload's plugin pipeline.

## Release and migration policy

Schema changes are versioned and documented in [CHANGELOG.md](./CHANGELOG.md). The host always generates, reviews, and applies its own Payload migration. Before production, run the repository's complete release gate and controlled canaries against each enabled provider account; automated tests never create or delete live social content.

## Documentation

- [Installation and deployment](./docs/installation.md)
- [Agent and headless integration](./docs/agent-integration.md)
- [Pinterest](./docs/pinterest.md)
- [Instagram Business](./docs/instagram.md)
- [Facebook Pages](./docs/facebook.md)
- [Google Business Profile](./docs/google-business-profile.md)
- [Architecture decisions](./docs/decisions/)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## License

MIT
