# payload-plugin-socials

Multi-platform organic social publishing for [Payload CMS](https://payloadcms.com) 3.

Compose, preview, template, schedule, publish, reconcile, and measure posts across Pinterest, Instagram Business, Facebook Pages, and Google Business Profile. The plugin provides real API adapters, encrypted credential storage, idempotency controls, a durable audit trail, and Payload-native admin surfaces. It does not provide a copy-and-paste fallback or embed application-specific catalog logic.

**Running in production at [Fine's Gallery](https://www.finesgallery.com).** This plugin was built for — and extracted from — Fine's Gallery, a 30-year-old luxury bronze and marble retailer with 660,000+ active users, where it is the social publishing control center. Live Pinterest Pins, Facebook Page posts, and Instagram posts on Fine's accounts are authored through this plugin's composer in production today. Google Business Profile is API-complete but has not yet published live content (it is gated on Google's Basic API Access approval); treat it as experimental until your own canary passes.

## What it adds

- A per-record Socials composer injected into the collections you choose.
- A standalone multi-channel composer at `/admin/socials`.
- Plugin-owned `social-posts` and `social-templates` collections.
- A hidden `socials-connections` global with AES-256-GCM encrypted tokens and key rotation.
- Pinterest image/video Pins, Instagram images/Reels/Stories/Carousels, Facebook link/photo/multi-photo/video posts, and GBP Standard/Event/Offer/Alert Local Posts.
- Destination discovery, preview, server-side validation, publication, history, deletion, reconciliation, insights, OAuth, and webhook endpoints.
- Payload Jobs task definitions for scheduled publication, retries, insights, and credential refresh. The host controls when workers run.
- Optional image-format preflight and deterministic JPEG rendition generation.

The host supplies source resolvers, authorization, credentials, the encryption key, and any scheduling trigger.

## Requirements

- Payload CMS `^3.84.1`
- Node.js `>=22.12.0`
- pnpm 9 or 10 when working in this repository
- `sharp` only when `assets.autoConvert` is enabled
- A public HTTPS origin for OAuth callbacks and provider-fetchable media

```bash
pnpm add payload-plugin-socials
```

## Platform readiness

| Platform                | Implementation                                                                                         | Release guidance                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinterest               | OAuth, board discovery/CRUD, image and video Pins, insights, delete                                    | **Live in production at Fine's Gallery**; run a controlled canary with your own credentials                                                   |
| Facebook Pages          | System-user or OAuth credentials; link, photo, multi-photo, video, native scheduling, insights, delete | **Live in production at Fine's Gallery**; your Meta app must be published (Live mode) for posts to be publicly visible                        |
| Instagram Business      | System-user or OAuth credentials; image, Reels, Stories, Carousel, insights                            | **Live in production at Fine's Gallery**; same Live-mode requirement; Meta exposes no post deletion — reconcile locally after removing in-app |
| Google Business Profile | OAuth or service account; account/location discovery; Standard, Event, Offer, Alert; insights, delete  | Experimental: API-complete and contract-tested, but requires Google Basic API Access and has not yet run a live canary                        |

Provider approval, quotas, and policy compliance remain the host's responsibility. See the platform guides before enabling an adapter.

> **Meta apps: publish the app before expecting public posts.** While a Meta app is in Development mode, Facebook and Instagram publishes succeed via the API and report `is_published: true` — but the content is visible **only to accounts holding a role on the app or Page**. Anyone else gets "content unavailable," which is easy to misread as a publishing failure. In the Meta App Dashboard, complete each use case's testing requirements and click **Publish** (the modern replacement for the old Development/Live toggle). Advanced Access for `pages_manage_posts` and `instagram_content_publish` plus Business Verification are required for a public app. Details in the [Facebook](./docs/facebook.md) and [Instagram](./docs/instagram.md) guides.

## Minimal configuration

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
        product: async ({ payload, id }) => {
          const product = await payload.findByID({ collection: 'products', id, depth: 1 })
          return {
            sourceId: String(product.id),
            sourceKind: 'product',
            baseTitle: product.title,
            baseDescription: product.description ?? '',
            link: `${process.env.PUBLIC_URL}/products/${product.slug}`,
            images: (product.gallery ?? []).flatMap((asset, index) =>
              typeof asset === 'object' && asset?.url
                ? [{ role: index === 0 ? 'main' : 'detail', url: asset.url }]
                : [],
            metadata: { sku: product.sku },
          }
        },
      },

      admin: {
        injectInto: [{ collection: 'products', sourceKind: 'product' }],
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
      allowedVideoHosts?: string[]
    }
    facebook?: {
      enabled: boolean
      appId?: string
      appSecret?: string
      redirectUri?: string
      systemUserAccessToken?: string
      apiVersion?: `v${number}.${number}`
    }
    instagram?: {
      enabled: boolean
      appId?: string
      appSecret?: string
      redirectUri?: string
      systemUserAccessToken?: string
      apiVersion?: `v${number}.${number}`
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
  }
  api?: { basePath?: `/${string}` }
  transformations?: SocialsTransformations
  copyOverrides?: SocialsCopyOverrides
  assets?: {
    preflight?: boolean
    autoConvert?: boolean
    renditionCollection?: string
    jpegQuality?: number
    remoteFetchTimeoutMs?: number
    trustedRemoteHosts?: string[]
  }
  scheduling?: {
    internalApiKey?: string
    autoRun?: {
      cron: string
      insightsRefreshCron?: string
      connectionRefreshCron?: string
      queue?: string
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

If a host has multiple auth-enabled collections, `authCollection` is required so the optional `publishedBy` relationship has an unambiguous target. A host with no auth collection may omit it; request authorization still remains mandatory.

Version `0.9.x` supports one `payloadPluginSocials(...)` instance per Payload config. Combine all enabled platforms and source resolvers in that instance. The plugin-owned collection, global, endpoint, and task slugs are intentionally fixed, and task runtime options are associated with the Payload instance; applying two plugin instances to one Payload config would create conflicting ownership.

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
  videos?: Array<{ url: string; posterUrl?: string }>
  modelLabel?: string | null
  metadata?: Record<string, unknown>
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
  product: {
    pinterestTitle: '{{ title }} | {{ metadata.material }}',
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

The plugin defines jobs; the host supplies cadence and workers. Any of these modes is valid:

- Payload Jobs `autoRun` configured through `scheduling.autoRun`.
- An external scheduler that calls `POST /api/socials/internal/jobs/sweep` with `X-Socials-API-Key`.
- A host worker that calls `sweepDueSocialPosts(payload, normalizedOptions)` and `runQueuedSocialsJobs(payload, normalizedOptions)`.

Scheduling uses a per-revision token, rechecks the due time in the task, and cancels superseded Payload jobs when possible. The token and status checks remain the correctness fence if cancellation races with a worker.

Facebook's `scheduledPublishTime` is provider-native scheduling. The generic source-publish `scheduledAt` is plugin scheduling. Accepted GBP posts and native Facebook schedules remain pending until reconciliation confirms the provider state; sweep jobs provide the backstop.

## Image safety

With preflight enabled, remote image inspection is HTTPS-only, redirect-bounded, time-bounded, and streamed under a 25 MB processing cap. Every redirect hostname is resolved and validated, and the HTTPS connection is pinned to that validated address while preserving the hostname for TLS SNI and certificate verification. DNS names resolving to local, private, link-local, documentation, or otherwise non-public IP ranges are rejected. `trustedRemoteHosts` is an explicit exact-host bypass for a host-controlled private media origin and should normally remain empty; those connections are still DNS-pinned.

Image detection uses file signatures, not URL extensions, so extensionless CDN URLs are supported. With preflight enabled, an unreadable or unrecognized signature fails closed instead of passing an uninspected asset to a provider. Set `assets.preflight: false` only when the host deliberately accepts that pass-through behavior.

When `autoConvert` is enabled, configure a dedicated public upload collection with no `formatOptions`; the plugin writes deterministic JPEG renditions there. Idempotency continues to use the original media URL.

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
