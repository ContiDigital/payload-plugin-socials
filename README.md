# payload-plugin-socials

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Payload](https://img.shields.io/badge/payload-%5E3.84-orange.svg)](https://payloadcms.com)
[![npm](https://img.shields.io/badge/npm-payload--plugin--socials-cb3837.svg)](https://www.npmjs.com/package/payload-plugin-socials)

Multi-platform organic social publishing for [Payload CMS 3](https://payloadcms.com). One plugin, one admin surface, four platforms:

- **Pinterest** (Pinterest API v5)
- **Instagram Business** (Meta Graph API v25.0)
- **Facebook Pages** (Meta Graph API v25.0)
- **Google Business Profile** (LocalPosts API)

Built for publishing at scale: image and video Pins, Instagram carousels, Reels and Stories, Facebook Page posts, and GBP STANDARD, EVENT, OFFER, and ALERT posts. Reusable post templates, a purpose-built social composer, a per-platform image pipeline, built-in scheduling, and encrypted token storage. It runs on any Payload host (Vercel, ECS, Fly, Render, self-hosted).

The `1.x` API follows semantic versioning. Schema changes are called out in the changelog so hosts can generate and apply their own Payload migrations.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Source resolvers](#source-resolvers)
- [Post templates](#post-templates)
  - [Template builder](#template-builder)
- [Copy transformations](#copy-transformations)
- [Per-platform setup](#per-platform-setup)
  - [Pinterest](#pinterest)
  - [Instagram Business](#instagram-business)
  - [Facebook Pages](#facebook-pages)
  - [Google Business Profile](#google-business-profile)
- [Publishing](#publishing)
- [Deleting a published post](#deleting-a-published-post)
- [Standalone composer](#standalone-composer)
- [Image asset pipeline](#image-asset-pipeline)
- [Scheduling (bring your own scheduler)](#scheduling-bring-your-own-scheduler)
- [Insights and analytics](#insights-and-analytics)
- [Admin UI](#admin-ui)
- [Encryption and secrets](#encryption-and-secrets)
- [Migration policy](#migration-policy)
- [REST endpoints](#rest-endpoints)
- [Programmatic API](#programmatic-api)
- [Tasks](#tasks)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Four complete adapters.** No manual-export shims or placeholder publish paths. Every platform implements validation, publish, delete, connection refresh, and post-level insights.
- **One purpose-built composer surface.** A `<SocialPublishPanelClient>` React component mounts on any host collection's edit view through a Socials tab. It uses a versioned `SocialDraft`, typed format controls, ordered media selection, resolved templates, debounced server validation, a platform preview, scheduling, and history. It never exposes adapter JSON to editors.
- **Standalone cross-channel composer.** Compose one post from inline content and publish it to every selected channel in a single call through `POST {basePath}/compose/publish`. Each channel succeeds or fails on its own, so one bad channel never blocks the rest.
- **Reusable post templates.** A `social-templates` collection holds per-channel template strings. A safe `{{ variable | filter }}` interpolation engine fills them per source record at compose time, with no `eval` and no way to reach the prototype chain.
- **Per-platform image pipeline.** Preflight an image against each platform's published constraints (format, minimum and maximum width, byte size, accepted aspect band) and resolve a crop or downscale target. An optional sharp transform executes the spec.
- **Source-polymorphic.** The host registers `SourceContextResolver`s keyed by `kind` (for example `product`, `project`, `blogPost`). The plugin does not know your content model. Resolvers translate `(kind, id)` into a normalized `SocialSourceContext` the adapters consume.
- **Bring your own scheduler.** Three integration modes that compose freely:
  1. Native Payload Jobs `autoRun` (the plugin registers a cron entry).
  2. External cron to HTTP (AWS EventBridge, Vercel cron, GitHub Actions, Fly machines, and the like) hitting the plugin's `/internal/jobs/sweep` endpoint with a pre-shared API key.
  3. A long-running worker process calling `runQueuedSocialsJobs(payload, options)` in a loop.
- **Idempotent publishing.** Each `(platform, sourceKind, sourceId, destination, primary asset)` tuple produces a stable SHA-256 idempotency key. The same input maps to the same `social-posts` row (upserted, never duplicated). Cancelled rows republish in place and preserve the audit log.
- **Encrypted token storage and rotation.** OAuth refresh tokens never live as plaintext. AES-256-GCM uses a 256-bit host-supplied primary key; a temporary previous-key ring supports zero-downtime rotation and re-encrypts credentials on read.
- **Retry and rate-limit handling.** Exponential backoff with jitter on 408, 425, 429, and 5xx, plus platform-specific `Retry-After` honoring, `X-App-Usage` quota tracking (Meta), `RetryInfo.retryDelay` (Google), and rolling 60-day continuous refresh tokens (Pinterest).
- **AWS-agnostic.** Zero `@aws-sdk` imports. The same plugin runs on Vercel, Fly, Render, self-hosted ECS, or anywhere Payload runs.

## Requirements

|          | Minimum                                                  |
| -------- | -------------------------------------------------------- |
| Payload  | `^3.84.0`                                                |
| Node.js  | `>=22.12.0`                                              |
| pnpm     | `^9` or `^10`                                            |
| Database | Postgres, SQLite, or MongoDB (anything Payload supports) |

The plugin's React components target React 18 and 19 with the `automatic` JSX runtime. `@payloadcms/ui` is an optional peer dependency, and `sharp` is an optional peer dependency needed only for the image transform helper. Drop both if you only need the server-side surface.

## Installation

```bash
pnpm add payload-plugin-socials
```

Then add it to your Payload config:

```ts
import { payloadPluginSocials } from 'payload-plugin-socials'
import { buildConfig } from 'payload'

export default buildConfig({
  // your usual config
  plugins: [
    payloadPluginSocials({
      encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!, // 32 bytes; hex or base64
      authorize: async ({ req, scope }) => {
        // your role check; return truthy to allow
        if (!req.user) return false
        if (scope === 'admin') return req.user.role === 'admin' || req.user.role === 'owner'
        return ['admin', 'owner', 'sales', 'marketing'].includes(req.user.role)
      },
      sources: {
        product: async ({ payload, id }) => {
          const product = await payload.findByID({ collection: 'products', id, depth: 2 })
          return {
            sourceId: String(product.id),
            sourceKind: 'product',
            baseTitle: product.title,
            baseDescription: product.description ?? '',
            link: `https://example.com/products/${product.slug}`,
            images: (product.images ?? []).map((img, i) => ({
              url: img.url,
              role: i === 0 ? 'main' : 'detail',
              width: img.width,
              height: img.height,
            })),
            metadata: {
              googleMaterial: product.material,
              categoryLabel: product.category?.name,
            },
          }
        },
      },
      platforms: {
        pinterest: {
          enabled: true,
          clientId: process.env.PINTEREST_CLIENT_ID!,
          clientSecret: process.env.PINTEREST_CLIENT_SECRET!,
          redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
        },
      },
      admin: {
        mode: 'route',
        injectInto: [{ collection: 'products', sourceKind: 'product' }],
      },
    }),
  ],
})
```

That is the minimum for a working install. The plugin registers a `social-posts` collection, a `social-templates` collection, and a `socials-connections` global, mounts a `/admin/socials` route and nav link, injects a Socials tab on your Products collection, and exposes the full REST surface under `/api/socials/...`.

---

## Quick start

After installation:

1. **Generate types**: `pnpm payload generate:types`. The plugin adds two collection slugs (`social-posts` and `social-templates`) and one global (`socials-connections`).
2. **Run migrations**: generate a migration with `pnpm payload migrate:create` for the new schema, commit it, then apply with `pnpm payload migrate`. The plugin never auto-creates migrations. That is always your call.
3. **Connect a platform**: navigate to `/admin/socials`, click "Connect Pinterest" (or another platform), and complete the OAuth flow. The plugin stores the encrypted refresh token on `socials-connections`.
4. **Publish a post**: open any record in the host collection where you injected the Socials tab, fill in a platform's fields, and click publish.
5. **Schedule a post (optional)**: choose a date and time in the composer. The plugin upserts a `queued` `social-posts` row and queues the publish task with `waitUntil`.

Some platforms connect through a system-user or service-account token supplied in your server configuration rather than through OAuth. Those connections show up in the Connections tab as connected with a "Managed by server configuration" badge and offer no Connect or Disconnect button. You change them by editing the server environment and redeploying, not from the admin UI. The `socials-connections` global itself is hidden from the admin nav and document view. It is internal AES-256-GCM token storage, and hand-editing the encrypted envelopes corrupts the tokens, so manage every connection from the Connections tab instead.

---

## Configuration

The full `PayloadPluginSocialsConfig` shape (TypeScript types are exported from the package):

```ts
type PayloadPluginSocialsConfig = {
  encryptionKey: string | Buffer // 32 bytes; hex, base64, or Buffer
  previousEncryptionKeys?: readonly (string | Buffer)[] // temporary rotation ring
  testMode?: boolean // forces sandbox env where supported
  disabled?: boolean // short-circuits the entire plugin

  authorize: AuthorizeFn // ({ req, scope }) => boolean | Promise<boolean>
  sources: Record<string, SourceContextResolver>

  admin?: {
    mode?: 'route' | 'dashboard' | 'both' | 'headless'
    navLabel?: string
    route?: `/${string}` // default '/socials'
    injectInto?: Array<{
      collection: CollectionSlug
      sourceKind: string // must match a key in `sources`
      label?: string // tab label; defaults to 'Socials'
      tabPosition?: 'append' | 'before-last' | number
    }>
  }

  api?: { basePath?: `/${string}` } // default '/socials'

  rateLimit?: {
    enabled?: boolean
    maxConcurrency?: number
    maxRequestsPerMinute?: number
    maxRetries?: number
    baseRetryDelayMs?: number
    maxRetryDelayMs?: number
    jitterFactor?: number
    requestTimeoutMs?: number
  }

  coordination?: {
    withLock?: SocialsDistributedLock
    acquireRequestLease?: SocialsAcquireRequestLease
  }

  webhooks?: {
    meta?: {
      verifyToken: string
      onEvent?: ({ event, platform, payload, req }) => Promise<void> | void
    }
  }

  scheduling?: SocialsSchedulingConfig // see "Scheduling" below

  copyOverrides?: {
    pinterestTitle?: (ctx: SocialSourceContext) => string
    pinterestDescription?: (ctx: SocialSourceContext) => string
    pinterestAltText?: (ctx: SocialSourceContext) => string
    pinterestHashtags?: (ctx: SocialSourceContext) => string[]
    instagramCaption?: (ctx: SocialSourceContext) => string
    facebookMessage?: (ctx: SocialSourceContext) => string
    gbpSummary?: (ctx: SocialSourceContext) => string
  }

  platforms: {
    pinterest?: PinterestPluginConfig
    instagram?: InstagramPluginConfig
    facebook?: FacebookPluginConfig
    gbp?: GbpPluginConfig
  }
}
```

For horizontally scaled workers, wire `coordination.withLock` to a fenced Redis or database lock and `coordination.acquireRequestLease` to the same shared quota backend. The lock serializes Pinterest's rotating refresh token across processes; the request lease enforces provider quotas across the fleet. Without these hooks, correctness still relies on database compare-and-set publication claims and each process enforces its own outbound limiter, which is appropriate for a single application instance.

---

## Source resolvers

A source is any host entity you publish from: a product, a project, a blog post, a customer testimonial, anything. The plugin does not know the shape of your host's data, so you register resolvers keyed by `kind`:

```ts
sources: {
  product: async ({ payload, id, req }) => {
    const product = await payload.findByID({ collection: 'products', id, depth: 2 })
    return {
      sourceId: String(product.id),
      sourceKind: 'product',
      baseTitle: product.title,
      modelLabel: product.modelId,            // optional secondary label
      baseDescription: product.description ?? '',
      link: buildUtmLink(product),            // host owns UTM strategy
      images: product.images.map((img, i) => ({
        url: img.url,
        role: i === 0 ? 'main' : 'detail',
        width: img.width,
        height: img.height,
      })),
      videos: product.videos?.map(v => ({ url: v.url, coverImageUrl: v.thumbnail })),
      metadata: {
        // The default Pinterest copy builder reads these from `metadata`:
        googleMaterial: product.material,
        googleColor: product.color,
        categoryLabel: product.category?.name,
        dimensions: formatDimensions(product),
      },
      hints: {
        // Free-form per-channel routing hints for the adapters or copy builders.
        pinterestSegments: ['marble-fireplaces'],
        instagramHashtags: ['luxury', 'marble', 'interiordesign'],
      },
    }
  },

  // Any number of additional kinds, all the same shape:
  project: async ({ payload, id }) => { /* ... */ },
  blogPost: async ({ payload, id }) => { /* ... */ },
}
```

Inside the host's admin UI, the Socials tab dispatches by `sourceKind` (matching the `injectInto.sourceKind` you set in `admin.injectInto`). The plugin throws a clear `NotFoundError` if a publish request references a kind without a registered resolver.

The composer deliberately does **not** embed Payload's Lexical editor or another rich-text implementation. Social APIs accept constrained copy, links, accessibility text, and ordered media—not HTML or arbitrary Payload blocks. If the host stores Lexical, Slate, or custom blocks, its resolver is the single translation boundary: convert that document into `baseTitle`, `baseDescription`, `images`, and `videos`. From there the plugin builds a stable `SocialDraft` and compiles strict per-platform inputs. This keeps custom blocks host-owned and prevents silent loss of unsupported formatting.

---

## Post templates

Templates let your team author reusable copy once and fill it per record at compose time. The plugin registers a `social-templates` collection that Payload renders with its built-in admin editor, so template authoring needs no custom UI.

Each template row holds per-channel strings with `{{ variable | filter }}` placeholders:

```
Pinterest title:        {{title}} | {{modelLabel}}
Pinterest description:  {{category}} crafted from {{material}}. {{description | truncate:300}}
Pinterest hashtags:     {{material}} {{color}} luxury
Instagram caption:      {{title}}\n\n{{description}}
GBP summary:            {{title}} now available.
```

The interpolation engine resolves dot paths against a friendly scope (`title`, `description`, `material`, `color`, `category`, `dimensions`, `link`, `modelLabel`, and `metadata.<field>`), runs a left to right filter pipeline (`upper`, `lower`, `trim`, `truncate:N`, `default:text`), and is safe by design: there is no `eval`, a missing path renders to an empty string rather than `undefined` or `[object Object]`, and `__proto__`, `constructor`, and `prototype` short-circuit so a template can never reach the prototype chain.

Render a template programmatically, or drive `copyOverrides` from a stored template string:

```ts
import { renderTemplate, buildTemplateScope, resolveTemplateCopy } from 'payload-plugin-socials'

// Render a single template against a source context:
const title = renderTemplate('{{title}} | {{modelLabel}}', buildTemplateScope(ctx))

// Resolve a whole social-templates row into per-channel copy (empty fields are
// dropped, hashtags are split and normalized to #tags):
const copy = resolveTemplateCopy(templateDoc.templates, ctx, { boardName: 'Statues' })
// => { pinterestTitle?, pinterestDescription?, pinterestHashtags?: string[], ... }
```

### Template builder

Each copy field in the `social-templates` collection mounts a `SocialTemplateFieldBuilder` component instead of a plain textarea. The builder provides:

- **Token picker.** Buttons for every statically-known scope token (`title`, `description`, `material`, `color`, `category`, `dimensions`, `link`, `modelLabel`, `sourceId`, `sourceKind`, `baseTitle`, `baseDescription`). After you select a sample record, any `metadata.*` keys that record exposes are added to the picker dynamically.
- **Filter menu.** After clicking a token, apply `truncate:N`, `default:...`, `upper`, `lower`, or `trim` in one click. The filter is written into the template string directly.
- **Live preview.** Enter a record ID in the preview panel and the builder POSTs to `POST {basePath}/templates/preview` every 350ms, showing the rendered output for that field against the real record.
- **Character count.** A per-field count with a warning when the rendered value would exceed the platform limit (100 chars for Pinterest title, 500 for description and alt text, 1500 for GBP summary, 2200 for Instagram caption).
- **Raw-string toggle.** Switch to a plain input or textarea to hand-write template syntax for advanced cases.

**Important:** the token picker only offers tokens that `buildTemplateScope` maps into the render scope. Collection fields that are not surfaced by the host's `SourceContextResolver` do not appear in the picker and would produce silent empty output if typed manually. To use a field, expose it through the resolver's `metadata` map and it will be discovered automatically in the live preview.

---

## Copy transformations

The `transformations` option is the recommended way to customize copy when you need source-kind-aware behaviour. It takes precedence over `copyOverrides` and is resolved at publish and preview time.

Each key is a source kind (for example `'product'`) and each value is a map of field names to transforms. The optional `'*'` key acts as a wildcard and applies to any source kind that has no explicit entry. Precedence from highest to lowest:

1. `transformations[ctx.sourceKind][field]` — kind-specific
2. `transformations['*'][field]` — wildcard fallback
3. `copyOverrides[field]` — legacy function-only overrides (still works)
4. The built-in default builder

A transform can be either a `{{ variable | filter }}` template string (rendered through the same engine as post templates) or a function that receives the `SocialSourceContext` directly:

```ts
payloadPluginSocials({
  // ...
  transformations: {
    product: {
      // Template string: uses the existing interpolation engine.
      pinterestTitle: '{{ title | upper }} | {{ modelLabel | default:Shop Now }}',

      // Template with truncation:
      pinterestDescription:
        '{{ category }} crafted from {{ material }}. {{ description | truncate:300 }}',

      // Function: full access to the source context.
      pinterestHashtags: (ctx) => {
        const base = ['#marble', '#luxury']
        if (ctx.metadata?.googleColor) {
          base.push(`#${String(ctx.metadata.googleColor).replace(/\s+/g, '')}`)
        }
        return base
      },
    },

    blogPost: {
      instagramCaption: (ctx) =>
        `${ctx.baseTitle}\n\n${ctx.baseDescription.slice(0, 200)}\n\n${ctx.link}`,
    },

    // Wildcard: applies when no kind-specific entry matches.
    '*': {
      facebookMessage: '{{ title }}\n\n{{ description | truncate:300 }}',
      gbpSummary: '{{ title }} -- {{ description | truncate:250 }}',
    },
  },
})
```

For `pinterestHashtags`, a string value is split on whitespace and commas and each token gets a `#` prefix when one is missing. A function value should return a `string[]` of `#tag` values directly.

`copyOverrides` continues to work for simple global function overrides. Use `transformations` when you need per-kind behaviour, template strings, or both.

---

## Per-platform setup

This is the quick version. Each platform also has a dedicated guide that covers
app creation, scopes, and the approval or review process:

- [Pinterest setup guide](docs/pinterest.md)
- [Instagram Business setup guide](docs/instagram.md)
- [Facebook Pages setup guide](docs/facebook.md)
- [Google Business Profile setup guide](docs/google-business-profile.md)

### Pinterest

Required scopes (the plugin requests these by default):

```
user_accounts:read, pins:read, pins:write, boards:read, boards:write
```

Continuous refresh tokens (`refresh_on=true`) are used by default. The legacy 365-day non-renewable refresh token is deprecated.

```ts
platforms: {
  pinterest: {
    enabled: true,
    clientId: process.env.PINTEREST_CLIENT_ID!,
    clientSecret: process.env.PINTEREST_CLIENT_SECRET!,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
    environment: 'production',         // or 'sandbox' for Pinterest's sandbox host
    allowedVideoHosts: ['cdn.example.com'], // required when publishing videoUrl
    videoUploadTimeoutMs: 900_000,     // default 15 minutes
    // scopes: [...]                   // override only when the host needs more
  },
}
```

Pinterest organic creation currently supports image and video Pins. The plugin implements the documented video flow: register media, stream the source to Pinterest's signed upload target without buffering the full file, poll processing, then create the Pin with a required cover image. `allowedVideoHosts` is an explicit SSRF boundary; every source redirect must remain on an allowlisted HTTPS host. Pinterest carousel creation is an ads format, not an organic Pin capability, so the adapter does not claim it.

Image preflight enforces Pinterest's 600px minimum width and surfaces a `belowMinWidth` flag on the preview for the admin UI.

### Instagram Business

Required scopes:

```
pages_show_list, pages_read_engagement, instagram_basic,
instagram_content_publish, instagram_manage_insights
```

Two credential modes, in precedence order:

1. **System user access token.** Preferred for backend SaaS. Provision in Business Manager (Settings, then Users, then System Users, then Add, then Generate New Token, expiration Never). The plugin treats this token as never-expiring and caches it for the process lifetime.
2. **OAuth User Login to a long-lived 60-day user token.** For multi-tenant flows where each tenant authorizes their own Facebook account.

```ts
platforms: {
  instagram: {
    enabled: true,
    apiVersion: 'v25.0',
    appId: process.env.META_APP_ID!,
    appSecret: process.env.META_APP_SECRET!,
    // Either supply a system user token...
    systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN,
    // ...or set up the OAuth flow:
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/instagram/oauth/callback`,
  },
}
```

IG Business publishing is two-phase. The plugin creates a media container, polls `status_code` until `FINISHED` (5s interval, 5 minute cap; videos and Reels often take 30s to 5 minutes), then publishes. Carousel children are created concurrently, each child is polled to `FINISHED`, and only then is the parent assembled.

Hard limits the plugin enforces in `validate`: caption at most 2200 chars, at most 30 hashtags, at most 20 mentions, and a carousel of 2 to 10 children that all share an aspect ratio.

### Facebook Pages

Required scopes:

```
pages_show_list, pages_read_engagement, pages_manage_posts
```

Same credential precedence as Instagram (system user, then long-lived user token).

Supported formats:

- `LINK`: text, or text plus a link with an auto-rendered preview card
- `PHOTO`: a single photo
- `PHOTO_MULTI`: 2 to 10 photos through `attached_media`
- `VIDEO`: a public URL through `file_url` (Meta fetches it)

The adapter deliberately uses Meta's server-side `file_url` ingestion because the canonical social media contract is a public source URL. This avoids proxying large video bytes through the Payload host. Local-file and resumable-session upload are outside the v1 source contract, not a hidden manual fallback.

### Google Business Profile

Single canonical scope: `https://www.googleapis.com/auth/business.manage`.

Two credential modes, in precedence order:

1. **OAuth User Login.** The tenant's GBP admin authorizes once. Refresh tokens do not expire from age but lapse after 6 months of inactivity. External OAuth apps left in Google's Testing status are a separate case: their `business.manage` refresh tokens expire after 7 days, so use Testing only for staging and complete publishing/verification for production.
2. **Service account.** JWT bearer flow. The service account email must be added as a Manager on the GBP account, or Workspace Domain-Wide Delegation must impersonate a Workspace user with manager access.

```ts
platforms: {
  gbp: {
    enabled: true,
    clientId: process.env.GBP_CLIENT_ID,
    clientSecret: process.env.GBP_CLIENT_SECRET,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/gbp/oauth/callback`,
    // OR the service-account path:
    // serviceAccount: {
    //   clientEmail: 'svc@project.iam.gserviceaccount.com',
    //   privateKey: process.env.GBP_SA_PRIVATE_KEY!,
    //   impersonate: 'admin@your-workspace-domain.com',  // optional, only with DWD
    // },
  },
}
```

Supported LocalPost topic types: `STANDARD`, `EVENT`, `OFFER`, and `ALERT`. The plugin validates per-topic required fields. For example OFFER requires both an `event` and an `offer` block and cannot include a `callToAction`, and ALERT requires an `alertType` and cannot carry media.

> [!NOTE]
> The GBP API requires Google to approve your Cloud project before granting quota above 0 QPM, and the `business.manage` scope is sensitive and requires OAuth verification before production. Plan 1 to 4 weeks of lead time for these.

---

## Publishing

### Immediate publish

`POST /api/socials/:platform/:sourceKind/:sourceId/publish` with the per-adapter input as the JSON body:

```ts
// Pinterest
fetch('/api/socials/pinterest/product/1234/publish', {
  method: 'POST',
  body: JSON.stringify({
    boardId: '549755885175',
    imageUrl: 'https://cdn.example.com/main.jpg',
    title: 'Optional title override',
    description: 'Optional description override',
  }),
})

// Instagram REELS
fetch('/api/socials/instagram/product/1234/publish', {
  method: 'POST',
  body: JSON.stringify({
    igUserId: '17841400000000000',
    mediaType: 'REELS',
    videoUrl: 'https://cdn.example.com/reel.mp4',
    coverUrl: 'https://cdn.example.com/cover.jpg',
    shareToFeed: true,
    caption: 'Optional caption override',
  }),
})

// Facebook PHOTO_MULTI
fetch('/api/socials/facebook/product/1234/publish', {
  method: 'POST',
  body: JSON.stringify({
    pageId: '100000000000001',
    format: 'PHOTO_MULTI',
    imageUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
    message: 'Optional message override',
  }),
})

// GBP STANDARD post
fetch('/api/socials/gbp/product/1234/publish', {
  method: 'POST',
  body: JSON.stringify({
    locationResourceName: 'accounts/106540000000000000000/locations/12345678901234567890',
    topicType: 'STANDARD',
    callToAction: { actionType: 'SHOP', url: 'https://example.com/marble' },
    imageUrl: 'https://cdn.example.com/main.jpg',
  }),
})
```

The response shape is uniform:

```jsonc
{
  "platform": "pinterest",
  "source": { "kind": "product", "id": "1234" },
  "publishedRef": {
    "platform": "pinterest",
    "externalId": "1130088566443544940",
    "externalUrl": "https://www.pinterest.com/pin/1130088566443544940/",
    "meta": { "boardId": "549755885175" },
  },
}
```

### Scheduled publish

Include `scheduledAt` (ISO-8601, at least 60 seconds in the future) in the publish payload:

```ts
fetch('/api/socials/pinterest/product/1234/publish', {
  method: 'POST',
  body: JSON.stringify({
    boardId: '549755885175',
    imageUrl: 'https://cdn.example.com/main.jpg',
    scheduledAt: '2026-06-15T10:00:00Z',
  }),
})
```

The plugin snapshots the input into a `social-posts` row with `status: 'queued'`, queues the publish task with `waitUntil`, and responds:

```jsonc
{
  "platform": "pinterest",
  "source": { "kind": "product", "id": "1234" },
  "scheduled": true,
  "postId": 42,
  "jobId": "abc123",
  "scheduledAt": "2026-06-15T10:00:00.000Z",
}
```

When the task fires, the plugin re-resolves the source context from your host data (so pricing and imagery updates between scheduling and publishing flow through naturally) and replays the snapshotted input against the adapter's publish path.

---

## Deleting a published post

Send `DELETE /api/socials/posts/:postId` with the `social-posts` row id. The endpoint is publisher-gated and available on all four platforms.

```ts
fetch(`/api/socials/posts/${postId}`, { method: 'DELETE' })
// => { ok: true, postId: 42, status: 'deleted' }
```

The handler calls the platform adapter's `delete` method to remove the post upstream, then soft-deletes the local row by setting its status to `deleted`. The row is never hard-deleted: it stays in the database as both the audit record and the idempotency anchor. `meta.deletedAt` (ISO timestamp) and `meta.deletedBy` (the requesting user's id) are written alongside the status change.

If the upstream platform returns a 404 or a "not found" error, the endpoint treats that as success. The post may already have been removed manually from the platform dashboard; the outcome is the same either way. Any other upstream error is returned to the caller and the row is left untouched.

Publishing the same content again after deletion reuses the existing row rather than creating a new one. The row transitions back to `published` in place, keeping the full history on a single database record.

The history panel in `SocialPublishPanelClient` shows a Delete button on each published row for Pinterest, Facebook, and GBP. Clicking it arms a confirmation prompt inline (same two-step pattern as the platform disconnect button), and confirming calls the endpoint and refreshes the list.

### Instagram: API deletion not supported

Meta's Graph API does not expose a delete endpoint for published Instagram Business media. `DELETE /{ig-media-id}` always returns `OAuthException` code 10, regardless of token or permissions. Instagram API deletion is removed as a capability in this plugin.

Calling `DELETE /api/socials/posts/:postId` on an Instagram row returns **HTTP 422** with an actionable message and leaves the local row untouched.

### Reconcile flow: mark-deleted

When an operator removes a post from the Instagram app directly, the local row stays `published` with a live `externalId`. The idempotency short-circuit would then return a stale reference forever and block republishing. Use `?localOnly=true` to reconcile:

```ts
fetch(`/api/socials/posts/${postId}?localOnly=true`, { method: 'DELETE' })
// => { ok: true, postId: 42, status: 'deleted' }
```

This skips all upstream platform calls for any platform, soft-deletes the local row (`status: 'deleted'`, `meta.deletedAt`, `meta.deletedBy`, `meta.deletedLocalOnly: true`), and makes the row re-claimable for republish-in-place. The same published and externalId guards apply. In the history panel, published Instagram rows show **"Mark deleted (removed in app)"** instead of Delete, which calls this path after the same two-step confirm.

> [!NOTE]
> The `deleted` status is a new enum value added to the `soc_post_status` column. Postgres hosts must run `pnpm payload migrate:create` and `pnpm payload migrate` after upgrading to this version. SQLite and MongoDB hosts do not require a migration for this change.

---

## Standalone composer

The source-polymorphic routes above publish from a host record. The standalone composer publishes content you type directly, with no source record, to many channels at once.

`POST /api/socials/compose/publish`:

```ts
fetch('/api/socials/compose/publish', {
  method: 'POST',
  body: JSON.stringify({
    content: {
      title: 'Spring Statuary Showcase',
      body: 'Join us this weekend for 50 new bronze and marble pieces.',
      imageUrl: 'https://cdn.example.com/showcase.jpg',
      link: 'https://example.com/events/spring',
    },
    targets: [
      { platform: 'pinterest', input: { boardId: '549755885175' } },
      { platform: 'instagram', input: { igUserId: '17841400000000000', mediaType: 'IMAGE' } },
      { platform: 'facebook', input: { pageId: '100000000000001', format: 'PHOTO' } },
    ],
  }),
})
```

Each channel is validated and published independently. A disabled platform, an invalid input, or an upstream error on one channel never blocks the others. The response carries a per-channel result and an `anyPublished` flag, and the status is 200 when at least one channel published or 502 when every channel failed:

```jsonc
{
  "anyPublished": true,
  "results": [
    {
      "platform": "pinterest",
      "ok": true,
      "publishedRef": { "externalId": "1130...", "platform": "pinterest" },
    },
    {
      "platform": "instagram",
      "ok": true,
      "publishedRef": { "externalId": "1792...", "platform": "instagram" },
    },
    {
      "platform": "facebook",
      "ok": false,
      "error": "No Page access token returned for Page 100000000000001",
    },
  ],
  "source": { "kind": "standalone", "id": "9f2c..." },
}
```

The same logic is available programmatically through `composeAndPublish` and `buildStandaloneContext` for hosts that want to run it from a server action.

---

## Image asset pipeline

Each platform has its own image rules. The pipeline validates an image against the right constraints and resolves a crop or downscale target before you publish.

```ts
import { preflightImage, resolveTargetDimensions, transformImage } from 'payload-plugin-socials'

// Validate an image's metadata against a platform's constraints:
const result = preflightImage('instagram', {
  width: 2000,
  height: 2000,
  format: 'jpeg',
  bytes: 3_000_000,
})
// result.ok is false on a blocking error (bad format, too small, over the byte limit);
// result.issues also carries warnings the pipeline will fix (a downscale or crop).

// Resolve the dimensions an image should be resized to:
const spec = resolveTargetDimensions('pinterest', { width: 2000, height: 1000 })
// => { width: 2000, height: 2000, fit: 'cover' }  (snapped to the platform aspect band)

// Execute the spec with sharp (an optional peer dependency):
const out = await transformImage(sourceBuffer, { ...spec, format: 'jpeg' })
```

`PLATFORM_IMAGE_CONSTRAINTS` is exported too, so you can surface the limits in your own UI. The values come from each platform's published media requirements: Pinterest at least 600px wide and 2:3, Instagram JPEG only at 320 to 1440px and 4:5 to 1.91:1, GBP at least 250 by 250 and 4:3, and so on.

---

## Scheduling (bring your own scheduler)

The plugin defines the scheduling tasks but does not impose a cadence. Pick whichever integration mode matches your infrastructure. They compose freely.

### Mode 1: Native Payload Jobs autoRun

If you run Payload's built-in jobs system, let the plugin register an autoRun entry:

```ts
payloadPluginSocials({
  // ...
  scheduling: {
    autoRun: {
      cron: '*/5 * * * *', // sweep due posts every 5 min
      insightsRefreshCron: '15 3 * * *', // refresh insights daily at 3:15am
      connectionRefreshCron: '30 2 * * *', // refresh tokens daily at 2:30am
    },
  },
})
```

The plugin registers under `config.jobs.autoRun` (idempotent, so re-applying the plugin does not stack entries). Make sure your Payload Jobs worker drains the `socials` queue.

### Mode 2: External cron (AWS EventBridge, Vercel cron, GitHub Actions, and the like)

Set an API key and hit the internal HTTP endpoints from anywhere:

```ts
payloadPluginSocials({
  // ...
  scheduling: {
    internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY!,
  },
})
```

```bash
# AWS EventBridge, Vercel cron, a plain cron job, a GitHub Action: all the same
curl -X POST 'https://your-host.com/api/socials/internal/jobs/sweep' \
  -H "X-Socials-API-Key: $SOCIALS_INTERNAL_API_KEY"
```

The endpoint sweeps due posts and drains the queue inline. It suits both serverless (Vercel) and long-running hosts.

### Mode 3: Long-running worker

If your deployment runs a dedicated worker process (for example an ECS Fargate task or a Fly machine), import the helpers directly:

```ts
import {
  runQueuedSocialsJobs,
  sweepDueSocialPosts,
  normalizePluginOptions,
} from 'payload-plugin-socials'

const options = normalizePluginOptions(/* the same options object you passed to the plugin */)

setInterval(async () => {
  await sweepDueSocialPosts(payload, options)
  await runQueuedSocialsJobs(payload, options)
}, 60_000)
```

### Mode 4: Hybrid

Nothing precludes mixing. For example: autoRun for the sweep on weekdays, external cron from a backup region as a safety net, plus an admin "Sweep now" button that hits `/internal/jobs/sweep` for incident response.

---

## Insights and analytics

The plugin runs a periodic `socialInsightsRefresh` task that pulls platform-side analytics for every `social-posts` row published within a configurable window (default: the last 30 days) and persists the snapshot onto `socialPosts.insightsSnapshot` with `insightsFetchedAt`. A failure on one post is isolated and does not abort the rest of the refresh.

All four adapters ship post-level analytics:

- **Pinterest:** Pin analytics over its 90-day rolling window, including impressions, clicks, saves, engagement rates, and video metrics.
- **Instagram:** media-type-aware insights for feed media, Reels, and Stories; unsupported metrics are never requested for the detected media product type.
- **Facebook:** current Page post metrics, including media views, unique media viewers, clicks, and reaction breakdowns. Deprecated `post_impressions*` metrics are not used.
- **Google Business Profile:** LocalPost `reportInsights` action and call-to-action totals.

Trigger a refresh manually:

```bash
curl -X POST 'https://your-host.com/api/socials/internal/insights/refresh' \
  -H "X-Socials-API-Key: $SOCIALS_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform": "pinterest", "windowSeconds": 604800, "limit": 100}'
```

---

## Admin UI

The plugin ships these React entry points (all exported from `payload-plugin-socials/client`):

- `<SocialPublishPanelClient>`: the multi-platform composer mounted through `admin.injectInto`, with a tab per platform.
- `<SocialsNavLink>`: the admin sidebar link to `/admin/socials`.
- `<SocialsDashboardWidget>`: the connection-health widget for `admin.mode: 'dashboard'`.

And a server component (from `payload-plugin-socials/rsc`):

- `<SocialsAdminView>`: the `/admin/socials` route shell.

Your `authorize` function gates both the REST API and the visibility of every admin surface. A user it rejects for the `publisher` scope sees nothing: no sidebar link, no `/admin/socials` route (they are redirected to the admin home), no dashboard widget, and an empty Socials tab with no composer forms and no error toasts. Each surface probes the read-only `GET {basePath}/access` endpoint (which reports `{ admin, publisher }` for the current user and never throws) and renders only when allowed, so authorization is enforced once in your `authorize` function rather than duplicated across components.

Post templates are authored directly in the `social-templates` collection, which Payload renders with its built-in collection editor.

The composer itself is a dedicated social UI, not a rich-text field. It exposes only semantics the target APIs preserve: channel copy, title where supported, destination, format, ordered image/video assets, accessibility text, topic-specific fields, CTA data, and scheduling. Host rich text and custom blocks are normalized once in `SourceContextResolver`, keeping the plugin independent of Payload's editor implementation.

Customize where the Socials tab appears through `admin.injectInto`, or skip auto-injection and place it manually with the exported helpers:

```ts
import { getSocialsTab, getSocialsField, SocialsUIPlaceholder } from 'payload-plugin-socials'

// Drop the placeholder anywhere in your collection's `fields`:
{
  type: 'tabs',
  tabs: [
    { label: 'General', fields: [...] },
    SocialsUIPlaceholder,        // the plugin replaces this during apply
    { label: 'SEO', fields: [...] },
  ],
}

// Or build the tab inline:
{
  type: 'tabs',
  tabs: [
    { label: 'General', fields: [...] },
    getSocialsTab('product'),
    { label: 'SEO', fields: [...] },
  ],
}
```

---

## Encryption and secrets

OAuth refresh tokens, and any access tokens persisted between requests, are stored in AES-256-GCM envelopes on the `socials-connections` global. The envelope shape:

```ts
{ version: 1, iv: '<base64-12-bytes>', ciphertext: '<base64>', authTag: '<base64-16-bytes>' }
```

The host supplies a 32-byte (256-bit) `encryptionKey` as a hex string, a base64 string, or a raw `Buffer`. Validation happens at plugin-init time, so a malformed key fails the boot rather than the first publish.

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rotate without downtime by deploying the new key as `encryptionKey` and the old key in `previousEncryptionKeys`. Any credential read with an old key is immediately re-encrypted with the primary key. Exercise every connection (or run the connection-refresh task), verify it succeeds, then remove the old key in a later deployment. Keep the old key available until every tenant or environment has completed that read-and-rewrite pass.

Log redaction: the plugin's `createPluginLogger` redacts `access_token`, `refresh_token`, `client_secret`, `app_secret`, `appsecret_proof`, `encryption_key`, `private_key`, `authorization`, `api_key`, `password`, and `cookie` (case-insensitive) at any depth before emitting to Payload's logger.

---

## Migration policy

The plugin adds these schema entities:

- **Collection** `social-posts`: the per-post audit and idempotency anchor.
- **Collection** `social-templates`: reusable per-channel post templates.
- **Global** `socials-connections`: per-platform encrypted credential state.

The plugin never auto-creates migrations. Run `pnpm payload migrate:create` after `pnpm payload generate:types` and commit the generated file. Then run `pnpm payload migrate` to apply it.

Schema changes between plugin versions are documented in [CHANGELOG.md](./CHANGELOG.md) under a dedicated migration note per release.

---

## REST endpoints

All routes are mounted under `options.api.basePath` (default `/socials`). The host-side Payload app exposes them under `/api/{basePath}/...`.

### Health

```
GET /api/socials/health
```

Returns the enabled platforms, the registered source kinds, and the test-mode flag.

### Access probe

```
GET /api/socials/access
```

Returns `{ admin, publisher }` for the current user by running your `authorize` for each scope. It never throws: an unauthenticated request, or an `authorize` that throws, reports both as `false`. The admin UI uses this to decide what to render; it is a capability probe, not a gate.

### OAuth (per platform)

```
POST  /api/socials/pinterest/oauth/start             # admin-gated; returns the authorize URL and sets a state cookie
GET   /api/socials/pinterest/oauth/callback          # cookie-gated; exchanges the code and redirects to /admin/socials
POST  /api/socials/pinterest/disconnect              # admin-gated; clears local credentials
```

Same shape for `/instagram/`, `/facebook/`, and `/gbp/`. Google and Meta disconnects revoke the upstream OAuth grant before local erasure. A Meta grant is app-wide, so Facebook and Instagram local credentials are both cleared when they share the same app. Config-managed system-user and service-account credentials cannot be disconnected at runtime. Pinterest does not currently publish a programmatic revocation endpoint, so its disconnect clears the encrypted local grant and the user must revoke the app from Pinterest account settings when full upstream revocation is required. Service-account-only GBP deployments omit `/oauth/start` and `/oauth/callback`.

```
GET   /api/socials/connections                       # admin-gated; connection state for enabled platforms
```

### Destination discovery

```
GET    /api/socials/pinterest/boards                 # publisher-gated; paginated full board list
POST   /api/socials/pinterest/boards                 # publisher-gated; creates a board (the test-mode guard applies)
DELETE /api/socials/pinterest/boards/:boardId        # admin-gated; idempotent

GET    /api/socials/facebook/pages                   # publisher-gated; page list (no tokens leaked)
GET    /api/socials/instagram/accounts               # publisher-gated; flat IG account list
GET    /api/socials/instagram/pages/:pageId/account  # publisher-gated; discover the IG user from a Page

GET    /api/socials/gbp/accounts                     # publisher-gated; manageable GBP accounts
GET    /api/socials/gbp/accounts/:accountId/locations # publisher-gated
GET    /api/socials/gbp/locations                    # publisher-gated; flattened postable locations
```

### Source-polymorphic publish

```
GET   /api/socials/:platform/:sourceKind/:sourceId/preview     # publisher-gated
POST  /api/socials/:platform/:sourceKind/:sourceId/validate    # publisher-gated; no side effects
POST  /api/socials/:platform/:sourceKind/:sourceId/publish     # publisher-gated; accepts an optional scheduledAt
GET   /api/socials/:platform/:sourceKind/:sourceId/history     # publisher-gated; the last 50 social-posts rows
GET   /api/socials/templates/:sourceKind/:sourceId             # publisher-gated; resolved enabled templates
POST  /api/socials/templates/preview                           # admin-gated; preview draft template fields + scopeKeys
```

### Post deletion

```
DELETE /api/socials/posts/:postId                    # publisher-gated; soft-deletes a published post upstream and locally
DELETE /api/socials/posts/:postId?localOnly=true     # publisher-gated; local-only soft-delete (reconcile path for IG + any platform)
```

Instagram rows return 422 on the plain DELETE. Use `?localOnly=true` after deleting the post in the Instagram app.

### Meta webhooks

When `webhooks.meta` is configured, the plugin mounts verified receiver pairs for every enabled Meta platform that has an app secret:

```
GET   /api/socials/facebook/webhook                 # hub challenge verification
POST  /api/socials/facebook/webhook                 # X-Hub-Signature-256 verified event
GET   /api/socials/instagram/webhook
POST  /api/socials/instagram/webhook
```

The raw body is capped at 1 MB and authenticated in constant time before `onEvent` runs. Configure the exact callback URL in the Meta app dashboard. Pinterest's public organic API does not expose an equivalent general webhook receiver, and GBP notifications use Google Pub/Sub rather than an inbound provider webhook; the host should bridge those events into its own worker when needed.

### Standalone composer

```
POST  /api/socials/compose/publish                   # publisher-gated; publishes inline content to many channels
```

### Internal scheduler (API-key gated)

```
POST  /api/socials/internal/jobs/sweep                # sweep due posts and drain the queue
POST  /api/socials/internal/jobs/run                  # drain only
POST  /api/socials/internal/jobs/queue/:taskSlug      # queue a specific task
POST  /api/socials/internal/posts/:postId/retry       # retry a specific failed or cancelled post
POST  /api/socials/internal/insights/refresh          # fire an insights refresh now
POST  /api/socials/internal/connections/refresh       # fire a connection refresh now
```

All are gated by the pre-shared `scheduling.internalApiKey`. Accepted header names: `X-Socials-API-Key`, `X-API-Key`, or `Authorization: Bearer <key>`. Comparison is constant-time through `crypto.timingSafeEqual`.

---

## Programmatic API

Beyond the curried factory, the plugin exports helpers hosts use for custom flows:

```ts
import {
  // Plugin entrypoint
  payloadPluginSocials,
  normalizePluginOptions,

  // Encryption
  coerceEncryptionKey,
  encryptString,
  decryptString,

  // Templates
  renderTemplate,
  buildTemplateScope,
  resolveTemplateCopy,

  // Standalone composer
  buildStandaloneContext,
  composeAndPublish,

  // Image asset pipeline
  preflightImage,
  resolveTargetDimensions,
  transformImage,
  PLATFORM_IMAGE_CONSTRAINTS,

  // Scheduling helpers
  queueSocialPostPublish,
  queueSocialPostRetry,
  queueSocialPostSweep,
  queueSocialInsightsRefresh,
  queueSocialConnectionRefresh,
  scheduleSocialPostPublish, // upsert a queued row and queue the task with waitUntil
  runQueuedSocialsJobs, // drain the queue (idempotent per Payload instance)
  sweepDueSocialPosts, // find due queued posts and queue their publishes

  // Constants
  PLUGIN_SLUG,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  SOCIAL_POSTS_SLUG,
  SOCIAL_TEMPLATES_SLUG,
  SOCIALS_CONNECTIONS_GLOBAL_SLUG,
  SOCIALS_QUEUE_NAME,
  STANDALONE_SOURCE_KIND,
  TASK_SLUGS_OWNED_BY_PLUGIN,

  // Tab placement helpers
  getSocialsTab,
  getSocialsField,
  SocialsUIPlaceholder,
} from 'payload-plugin-socials'
```

The full type surface is exported alongside (see `src/types/index.ts` in the source).

---

## Tasks

Slugs registered on `config.jobs.tasks` (you can also wire them into your own autoRun config manually instead of using the plugin's):

| Slug                      | Description                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `socialPostPublish`       | The workhorse. Replays a snapshotted publish from a `social-posts` row                       |
| `socialPostRetry`         | Flips a failed post back to `queued` and re-queues the publish task                          |
| `socialPostSweep`         | Scans `social-posts` for `queued` rows where `scheduledAt <= now` and queues their publishes |
| `socialInsightsRefresh`   | Pulls platform-side analytics for posts in the configured window                             |
| `socialConnectionRefresh` | Proactively refreshes access tokens approaching expiry                                       |

All run on the `socials` queue by default. Override it through `scheduling.autoRun.queue`.

---

## Troubleshooting

**OAuth callback returns "state mismatch".** The state cookie (`socials_*_oauth_state`) is HttpOnly, SameSite=Lax, and Secure. If you are testing over `http://localhost`, browsers may reject the cookie. Test over HTTPS (for example a tunneled URL) or temporarily relax the cookie attributes during development.

**"No Pinterest access token available, reconnect the account".** The refresh token in `socials-connections.pinterest.refreshToken` failed to refresh. Common causes: the 60-day continuous refresh window elapsed, Pinterest revoked the app's grant, or a sandbox vs production environment mismatch. Reconnect through `/admin/socials`.

**Instagram container expires before publish (24h limit).** This happens when a container sits unpublished for more than 24 hours. The plugin's IG publish path polls `status_code` and surfaces `EXPIRED` as a `PlatformApiError(410)`. Re-queue the post with `POST /api/socials/internal/posts/:postId/retry`.

**GBP returns 403 PERMISSION_DENIED on a known-good location.** Check `metadata.canOperateLocalPost` on the location. Suspended, duplicate, and pending-verification locations return `false`. The plugin's location listing filters these out automatically.

**Tasks register but never fire.** Confirm that you have either (a) configured `scheduling.autoRun` and your Payload Jobs worker is draining the `socials` queue, or (b) configured `scheduling.internalApiKey` and your external cron is calling `POST /api/socials/internal/jobs/sweep`. See the [Scheduling](#scheduling-bring-your-own-scheduler) section.

**Encryption key rejected at boot.** The key must decode to exactly 32 bytes. Generate a fresh one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

---

## Contributing

Issues and PRs are welcome. Before submitting:

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm pack:smoke   # full publish smoke test
```

The plugin authoring conventions (file layout, type system, hook injection, job pattern, and so on) are documented in `CLAUDE.md` in the repo. That file is internal and gitignored, but the patterns themselves are stable.

---

## License

[MIT](LICENSE) © Conti Digital
