# payload-plugin-socials

A social publishing control center for [Payload CMS](https://payloadcms.com) v3.

Compose, preview, template, schedule, publish, and track organic posts across Pinterest, Instagram, Facebook, and Google Business Profile, all from inside Payload's admin panel and driven by the content you already manage. Every platform is a real API integration with encrypted OAuth, idempotent publishing, and a full audit trail. No copy-paste export tabs, no manual mode.

**Running in production at [Fine's Gallery](https://finesgallery.com).** This plugin powers real social publishing for Fine's Gallery, a 30-year luxury marble and bronze retailer doing $2.4M/year, where staff turn products, projects, and collections into Pinterest pins and Instagram and Facebook posts without leaving the CMS. It began as the Pinterest engine behind that store and was generalized into the four-platform plugin documented here.

The plugin ships the reusable machinery and nothing else: the composer, the platform adapters, encrypted token storage, the template engine, scheduling, and the audit collection. Anything application-specific (segments, catalog feeds, product enrichment) stays in your host code, reached through the source resolvers you write.

## Why it exists

Publishing the same catalog to four networks by hand is slow, error-prone, and impossible to audit. Off-the-shelf schedulers live outside your data and can't see your products, prices, or media. This plugin closes that gap:

- **Your content is the source.** Open a product, a blog post, or a project and publish it directly. Copy and media come from a resolver you write, so a post is always in sync with the record.
- **One composer, every platform.** The same panel drives Pinterest boards, Facebook Pages, Instagram feeds, Reels, Stories, and Carousels, and Google Business Profile posts, with a live per-platform preview and per-platform character limits.
- **Publish once, safely.** Every publish is idempotent and audited; re-publishing the same content returns the existing post instead of duplicating it.
- **Templated, on-brand copy.** Operator-defined transformations and staff-editable templates keep voice consistent across thousands of posts.
- **Built for real infrastructure.** Encrypted tokens, access control on every surface, format-safe media, and scheduling that plugs into whatever you already run.

## What the plugin does

When enabled, the plugin:

1. Adds a **Socials** tab to any collection you choose, with a per-record composer: pick a platform, pick a destination (board, Page, IG account, location), pick a format, choose and order media, write or template the copy, watch a live preview, then publish or schedule.
2. Mounts a **standalone composer** at `/admin/socials` for ad-hoc posts that aren't tied to a document, publishable to several channels at once.
3. Registers a `social-posts` collection (one audited, idempotent row per publish, with per-platform status, external IDs, and insights) and a `social-templates` collection (reusable copy templates bound to a source kind).
4. Stores OAuth tokens **encrypted at rest** (AES-256-GCM) in a hidden `socials-connections` global, with key rotation support.
5. Exposes a **full REST surface** under `/api/socials/*`: OAuth, destination discovery, preview, validate, publish, history, delete, insights, and scheduling.
6. Enforces **access control** on every endpoint and every admin surface through your own `authorize` function. Users you reject see nothing at all.
7. Handles **platform media rules** automatically: pre-publish format validation and optional WebP/AVIF to JPEG transcoding for the platforms that demand it.
8. Defines the **scheduled-publish, insights-refresh, and connection-refresh** tasks. You wire the trigger (Payload cron, EventBridge, a worker loop, whatever you run).

Everything is driven by **source resolvers** you write: small functions that map one of your documents into a channel-agnostic shape the composer understands. Register a resolver per collection kind and the composer, templates, and copy builders work identically across all of them.

## Requirements

- Payload CMS `^3.37.0`
- Node.js `^18.20.2 || >=20.9.0`
- **A long-running server process** for scheduling (EC2, ECS, a VPS, a worker). Immediate publishing works anywhere; see [Scheduling](#scheduling).

```bash
pnpm add payload-plugin-socials
```

## Platform maturity

| Platform                    | Status         | Capabilities                                                                                                                                                                                                                                                                |
| --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pinterest**               | **Production** | OAuth, board discovery and creation, image and video pins, insights. The originating integration, running against real catalogs.                                                                                                                                            |
| **Facebook Pages**          | **Production** | Text, link, single photo, multi-photo, and video posts. Live at Fine's Gallery via a Business Manager system-user token.                                                                                                                                                    |
| **Instagram Business**      | **Production** | Image, video, Reels, Stories, and Carousel posts. Live at Fine's Gallery via a Business Manager system-user token.                                                                                                                                                          |
| **Google Business Profile** | Experimental   | LocalPosts (Standard, Event, Offer, Alert) implemented to spec, not yet exercised against the live API. GBP posting requires Google's Basic API Access approval per host, so validate in your own approved project. See [the GBP guide](./docs/google-business-profile.md). |

Three of the four platforms are live in production. Google Business Profile is code-complete and gated only by Google's per-host access approval, which every GBP integrator obtains independently.

## Minimal setup

```ts
import { buildConfig } from 'payload'
import { payloadPluginSocials } from 'payload-plugin-socials'

export default buildConfig({
  plugins: [
    payloadPluginSocials({
      encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!, // 32 bytes; hex or base64

      // Who can use the plugin. `scope` is 'admin' (manage connections and
      // templates) or 'publisher' (compose and publish). Map onto your roles.
      authorize: async ({ req, scope }) => {
        const role = req.user?.role
        if (!role) return false
        return scope === 'admin'
          ? ['admin', 'owner'].includes(role)
          : ['admin', 'owner', 'editor'].includes(role)
      },

      // One resolver per collection you want to publish from.
      sources: {
        product: async ({ payload, id }) => {
          const p = await payload.findByID({ collection: 'products', id, depth: 1 })
          return {
            sourceId: String(p.id),
            sourceKind: 'product',
            baseTitle: p.title,
            baseDescription: p.description ?? '',
            link: `${process.env.PUBLIC_URL}/products/${p.slug}`,
            images: (p.gallery ?? [])
              .filter((m) => m?.url)
              .map((m, i) => ({ url: m.url, role: i === 0 ? 'main' : 'detail' })),
          }
        },
      },

      // Where the Socials tab appears, and which resolver drives each collection.
      admin: {
        mode: 'both',
        injectInto: [{ collection: 'products', sourceKind: 'product' }],
      },

      platforms: {
        facebook: {
          appId: process.env.META_APP_ID!,
          appSecret: process.env.META_APP_SECRET!,
          systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
        },
        instagram: {
          appId: process.env.META_APP_ID!,
          appSecret: process.env.META_APP_SECRET!,
          systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
        },
      },
    }),
  ],
})
```

Then generate types, generate the admin import map, and create a migration:

```bash
pnpm payload generate:types
pnpm payload generate:importmap   # required, or the admin components render blank
pnpm payload migrate:create socials && pnpm payload migrate
```

That mounts the REST surface under `/api/socials/*`, adds a Socials tab to your products collection, registers the `social-posts` and `social-templates` collections and the `socials-connections` global, and adds the `/admin/socials` route. See [docs/installation.md](./docs/installation.md) for the full walkthrough.

## Configuration reference

### Required options

| Option          | Type                                    | Description                                                               |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `encryptionKey` | `string \| Buffer`                      | 32-byte key (hex or base64) for encrypting stored OAuth tokens            |
| `authorize`     | `({ req, scope }) => boolean`           | Access control for the API and admin surfaces; `scope` is admin/publisher |
| `sources`       | `Record<string, SourceContextResolver>` | At least one resolver, keyed by source kind                               |
| `platforms`     | `object`                                | At least one platform configured (Pinterest, Facebook, Instagram, GBP)    |

### All options

```ts
payloadPluginSocials({
  // --- Required ---
  encryptionKey: string | Buffer,                 // 32 bytes, hex or base64
  authorize: ({ req, scope }) => boolean | Promise<boolean>,
  sources: Record<string, SourceContextResolver>, // one per source kind
  platforms: {
    pinterest?: { clientId, clientSecret, redirectUri, environment?: 'production' | 'sandbox' },
    facebook?:  { appId, appSecret, systemUserAccessToken?, redirectUri?, apiVersion? },
    instagram?: { appId, appSecret, systemUserAccessToken?, redirectUri?, apiVersion? },
    gbp?:       { clientId, clientSecret, redirectUri, serviceAccount? },
  },

  // --- Admin UI ---
  admin?: {
    mode?: 'route' | 'dashboard' | 'both' | 'headless',  // default: 'route'
    route?: `/${string}`,                                // default: '/socials'
    navLabel?: string,                                   // default: 'Socials'
    injectInto?: Array<{ collection, sourceKind, label?, tabPosition? }>,
  },

  // --- Copy ---
  transformations?: SocialsTransformations,  // config-first, per-source-kind copy
  copyOverrides?: SocialsCopyOverrides,       // simple function overrides

  // --- Image pipeline ---
  assets?: {
    autoConvert?: boolean,          // transcode disallowed formats to JPEG
    renditionCollection?: string,   // upload collection for converted renditions
    jpegQuality?: number,           // default: 82
    preflight?: boolean,            // default: true; validate formats before publish
  },

  // --- Scheduling ---
  scheduling?: {
    internalApiKey?: string,
    autoRun?: { cron, insightsRefreshCron?, connectionRefreshCron?, queue? },
    sweepBatchSize?: number,
    connectionRefreshWindowSeconds?: number,
    insightsRefreshWindowSeconds?: number,
  },

  // --- API + operations ---
  api?: { basePath?: `/${string}` },  // default: '/socials'
  rateLimit?: SocialsRateLimitConfig, // concurrency, retries, backoff, distributed store
  webhooks?: SocialsWebhookConfig,    // optional comment/mention receivers
  previousEncryptionKeys?: (string | Buffer)[],  // for key rotation
  testMode?: boolean,                 // e.g. Pinterest sandbox
  disabled?: boolean,                 // build config without the plugin active
})
```

## Source resolvers

Resolvers are the primary integration point. A resolver maps one of your documents into a `SocialSourceContext`, the channel-agnostic shape the composer, templates, and copy builders all operate on. You write one per source kind; the composer treats them all the same.

```ts
type SourceContextResolver = (args: {
  id: number | string
  payload: Payload
  req?: PayloadRequest
}) => Promise<SocialSourceContext>

interface SocialSourceContext {
  sourceId: string // stable id of the record (stringified)
  sourceKind: string // the kind key, e.g. 'product'
  baseTitle: string // channel-agnostic title
  baseDescription: string // channel-agnostic body
  link: string // outbound URL (bake in UTM params if you want)
  images: SocialImage[] // in preference order; the UI surfaces all of them
  videos?: SocialVideo[]
  modelLabel?: string | null // optional secondary label
  metadata?: Record<string, unknown> // anything else; reachable in templates as {{ metadata.key }}
}

interface SocialImage {
  url: string // must be publicly fetchable by the platform
  role: 'main' | 'detail' | 'lifestyle' | string
  width?: number
  height?: number
  format?: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'bmp' | 'tiff'
  alt?: string
}
```

### Register a resolver per collection type

The point of the resolver registry is that **any collection can become a social source**. A product, a blog post, a project, a category: each just needs a function that produces a `SocialSourceContext`. Register the kinds you want and point `admin.injectInto` at the matching collections.

```ts
sources: {
  product: async ({ payload, id }) => {
    const p = await payload.findByID({ collection: 'products', id, depth: 1 })
    return {
      sourceId: String(p.id),
      sourceKind: 'product',
      baseTitle: p.title,
      baseDescription: p.description ?? '',
      link: `${base}/products/${p.slug}`,
      images: imagesFrom(p.gallery),
      metadata: { material: p.material, price: p.price },  // -> {{ metadata.material }}
    }
  },

  blogPost: async ({ payload, id }) => {
    const post = await payload.findByID({ collection: 'posts', id, depth: 1 })
    return {
      sourceId: String(post.id),
      sourceKind: 'blogPost',
      baseTitle: post.title,
      baseDescription: post.excerpt ?? '',
      link: `${base}/blog/${post.slug}`,
      images: imagesFrom([post.heroImage]),
      metadata: { author: post.author?.name, published: post.publishedOn },
    }
  },

  project: async ({ payload, id }) => {
    const project = await payload.findByID({ collection: 'projects', id, depth: 1 })
    return {
      sourceId: String(project.id),
      sourceKind: 'project',
      baseTitle: project.title,
      baseDescription: project.description ?? '',
      link: `${base}/work/${project.slug}`,
      images: imagesFrom([project.hero, ...(project.gallery ?? [])]),
      metadata: { location: project.location, completed: project.date },
    }
  },
},

admin: {
  mode: 'both',
  injectInto: [
    { collection: 'products', sourceKind: 'product' },
    { collection: 'posts',    sourceKind: 'blogPost' },
    { collection: 'projects', sourceKind: 'project' },
  ],
},
```

Guidance that pays off in production:

- **`metadata` is the extension surface.** Every key you place there is reachable in templates as `{{ metadata.<key> }}` and appears in the template builder's field picker once a sample record is resolved. If a copywriter asks for a field, expose it here. Do not stuff domain fields into `baseTitle`/`baseDescription`.
- **Set `format` on images** (the mime subtype). It powers pre-publish format validation, so a WebP image on an Instagram post is flagged in the composer instead of failing at publish time. See [Image handling](#image-handling).
- **Image URLs must be publicly fetchable.** The platforms fetch your images server-side: no localhost, no signed URLs that expire quickly, no IP allowlists. Point resolvers at your CDN.
- **Pull related records if it helps.** A category resolver can query the products in that category and add their images to `images`, while `link` still points at the category page. A resolver is just a function; use the full Payload API.

### Enrich a parent from its children (a real pattern)

```ts
category: async ({ payload, id }) => {
  const category = await payload.findByID({ collection: 'categories', id, depth: 1 })
  const members = await payload.find({
    collection: 'products',
    where: { categories: { in: [id] } },
    depth: 1,
    limit: 24,
  })
  return {
    sourceId: String(category.id),
    sourceKind: 'category',
    baseTitle: category.title,
    baseDescription: category.description ?? '',
    link: `${base}/browse/${category.slug}`,  // link stays on the category page
    images: [
      ...imagesFrom([category.image]),
      ...members.docs.flatMap((p) => imagesFrom([p.mainImage])),  // but publish a product shot
    ],
  }
},
```

## Copy: transformations and templates

Default copy is generated from the source context. You customize it two ways, and they layer.

**Config transformations** are the operator-set defaults, declared in code and keyed by source kind. Each field is a template string (rendered through the `{{ variable | filter }}` engine) or a function that receives the full context.

```ts
transformations: {
  product: {
    pinterestTitle: '{{ title | upper }} | {{ metadata.material }}',
    pinterestHashtags: (ctx) => ['#design', `#${ctx.metadata?.material ?? 'home'}`],
  },
  '*': {
    facebookMessage: '{{ title }}\n\n{{ description | truncate:300 }}',
  },
},
```

**Templates** are staff-editable variants, created in the admin and bound to a collection. Each template is tied to a source kind, so a product template only appears when composing from products. Mark one "default for this collection" and it auto-applies. A template built in the admin uses the same interpolation engine, with a token picker scoped to that collection's real fields.

Precedence, most specific first: a template chosen for the post, then a default template for the kind, then config `transformations`, then the built-in copy builders.

Available filters: `upper`, `lower`, `trim`, `truncate:N`, `default:text`.

## Platform credentials

Each platform is configured under `platforms`. Only the platforms you configure are enabled.

- **Pinterest** is OAuth only. Supply `clientId`, `clientSecret`, `redirectUri`. A publisher connects once from `/admin/socials`; the refresh token is stored encrypted and rotates automatically.
- **Facebook and Instagram** share a Meta app. For a single-tenant install, a Business Manager **system-user token** is the simplest option: it never expires, needs no OAuth flow or App Review, and shows as connected automatically. Supply `appId`, `appSecret`, `systemUserAccessToken`. For multi-tenant products, supply `redirectUri` instead and each customer connects their own Page.
- **Google Business Profile** is OAuth with a `business.manage` scope, gated by Google's Basic API Access approval.

Per-platform setup, scopes, and gotchas live in the platform guides:

- [Pinterest](./docs/pinterest.md)
- [Instagram](./docs/instagram.md)
- [Facebook](./docs/facebook.md)
- [Google Business Profile](./docs/google-business-profile.md)

## The composer

The composer is where the work happens, and it adapts to each platform:

- **Platform tabs** switch between Pinterest, Instagram, Facebook, and GBP, each with its own destination picker (board, Page, IG account, location), format selector, and copy fields. State is kept per platform, so you can tune a post for each network before publishing.
- **Format-aware fields.** Choosing a format (Reel, Carousel, Offer, and so on) reshapes the form and the accepted media. Selecting an image format hides video, and vice versa; incompatible selections are pruned with a notice instead of failing at publish.
- **Media pool with ordering.** Images and videos from the resolver, plus anything added from the media library or a URL, share one pool across the platform tabs. For multi-asset formats (Carousel, multi-photo) you drag or arrow-key to set the exact order, shown with numbered badges.
- **Live preview.** A per-platform preview renders the title, body, link, and selected media as they will appear, updating as you type.
- **Character limits and validation** are enforced per platform in the UI, and again server-side at publish, so limits are never silently exceeded.

## Publishing

From a document's Socials tab or the standalone composer: choose a platform and destination, review the preview, and publish. Every publish is **idempotent and audited**. The plugin computes a per-platform key from `(platform, source, destination, primary asset)` and upserts a `social-posts` row on it, so publishing the same content twice returns the existing post instead of duplicating it. Each row records the platform, destination, status, external ID and URL, and a content fingerprint, giving you a complete, queryable history of what was posted where.

Programmatic publishing is available for automations and scripts:

```ts
import { composeAndPublish } from 'payload-plugin-socials'

const result = await composeAndPublish({
  payload,
  platform: 'pinterest',
  source: { kind: 'product', id: 42 },
  input: { boardId: '...' /* platform-specific fields */ },
})
```

### Deleting a post

Published posts can be deleted from the composer's history list. The plugin removes the post upstream (where the platform allows it) and soft-deletes the local row to `status: 'deleted'`, preserving the audit trail and idempotency anchor. Rows are never hard-deleted.

Instagram is the exception: the Graph API has no delete endpoint for published media. The composer offers a **Mark deleted (removed in app)** action instead, which reconciles the local record after you remove the post in the Instagram app.

## Scheduling

The plugin defines the tasks; you fire the trigger. Set `scheduling.internalApiKey` (and optionally `scheduling.autoRun.cron`), then pick one:

- **Native Payload Jobs.** Set `scheduling.autoRun.cron` and run a Payload jobs worker. The plugin registers the autoRun entry and the task definitions.
- **External cron.** Have EventBridge, Vercel cron, a GitHub Action, or a plain cron job `POST /api/socials/internal/jobs/sweep` every few minutes with the `X-Socials-API-Key` header.
- **Long-running worker.** Import `sweepDueSocialPosts` and `runQueuedSocialsJobs` and call them in a loop.

A scheduled post is a `queued` row with a `scheduledAt` in the future; the sweep publishes due rows. Scheduling from the composer is safe: past or near-past times are rejected rather than published immediately, and queued posts show their scheduled time and can be cancelled.

## Image handling

Platforms disagree on formats. Instagram accepts JPEG only; Facebook and GBP reject WebP and AVIF; Pinterest accepts more. If your media is not guaranteed JPEG, enable automatic conversion:

```ts
assets: {
  autoConvert: true,
  renditionCollection: 'social-renditions',  // a dedicated upload collection, see below
},
```

The plugin detects the true format by magic bytes, transcodes to JPEG with sharp, uploads the rendition under a deterministic name (re-publishes reuse it), and sends the platform the rendition URL. Idempotency keys always derive from the original URL, so conversion never fragments post identity.

The rendition collection must not itself re-encode. Point it at a plain upload collection with no `formatOptions`, or Payload will convert the plugin's JPEG right back. Full example in [docs/installation.md](./docs/installation.md).

## Insights and analytics

The plugin can pull engagement data back from each platform and snapshot it onto the `social-posts` row, so performance lives next to the post that produced it. The `socialInsightsRefresh` task walks published posts in a configurable window per platform, calls each adapter's insights endpoint, and stores the result on `insightsSnapshot` with a fetched-at timestamp. Trigger it on a schedule alongside the publish sweep. Pinterest pin metrics, Facebook and Instagram post metrics, and GBP LocalPost metrics are all supported by their adapters.

## Admin surfaces

- **Per-record Socials tab** on every injected collection: the full composer, plus a history list of everything published from that record with delete and reconcile actions.
- **Standalone composer** at `/admin/socials`: compose one post and publish it to multiple channels at once, with a connections panel showing the health of each platform.
- **Dashboard widget** (when `admin.mode` includes it): connection status at a glance.

Every one of these is gated by `authorize`, styled with Payload's theme variables, and keyboard-navigable.

## Access control

Every REST endpoint and every admin surface (the nav link, the `/admin/socials` route, the dashboard widget, the composer) is gated by your `authorize` function. A user your `authorize` rejects sees nothing: no menu entry, no route, no forms. Mutations distinguish 401 (not signed in) from 403 (signed in, not permitted).

`authorize` receives `{ req, scope }` where `scope` is `'admin'` (connection management, template authoring) or `'publisher'` (composing and publishing). Return truthy to allow.

## Encryption and secrets

OAuth tokens are stored encrypted with AES-256-GCM. You supply a 32-byte `encryptionKey` (hex or base64). Keep it stable for the life of the environment; changing it orphans stored tokens. To rotate, pass the old key(s) in `previousEncryptionKeys` so existing tokens decrypt during the transition. The plugin never logs token values.

## Migration policy

The plugin contributes schema (the `social-posts` and `social-templates` collections, the `socials-connections` global) but never writes or runs migrations. After installing or upgrading, you run `payload migrate:create` and apply it, as you would for any schema change. Version bumps that change schema are called out in the changelog.

## REST endpoints

All under your configured `api.basePath` (default `/socials`).

| Method | Path                               | Auth                        |
| ------ | ---------------------------------- | --------------------------- |
| GET    | `/health`                          | none                        |
| GET    | `/access`                          | any user (capability probe) |
| POST   | `/{platform}/oauth/start`          | admin                       |
| GET    | `/{platform}/oauth/callback`       | OAuth state cookie          |
| POST   | `/{platform}/disconnect`           | admin                       |
| GET    | `/connections`                     | admin                       |
| GET    | `/{platform}/{kind}/{id}/preview`  | publisher                   |
| POST   | `/{platform}/{kind}/{id}/validate` | publisher                   |
| POST   | `/{platform}/{kind}/{id}/publish`  | publisher                   |
| GET    | `/{platform}/{kind}/{id}/history`  | publisher                   |
| DELETE | `/posts/{id}`                      | publisher                   |
| POST   | `/compose/publish`                 | publisher                   |
| POST   | `/templates/preview`               | admin                       |
| POST   | `/internal/jobs/sweep`             | API key                     |

Destination discovery endpoints (`/pinterest/boards`, `/facebook/pages`, `/instagram/accounts`, `/gbp/locations`) and the internal scheduler routes are documented in [docs/installation.md](./docs/installation.md).

## Exports

```ts
// payload-plugin-socials
import {
  payloadPluginSocials, // the plugin factory (default export too)
  composeAndPublish, // programmatic publish
  sweepDueSocialPosts, // scheduling: publish due queued posts
  runQueuedSocialsJobs, // scheduling: drain the queue
  renderTemplate, // the {{ }} interpolation engine
  transformImage, // sharp-based transcode helper
} from 'payload-plugin-socials'

import type {
  PayloadPluginSocialsConfig,
  SourceContextResolver,
  SocialSourceContext,
  SocialImage,
} from 'payload-plugin-socials'

// payload-plugin-socials/client — admin components (for manual placement)
// payload-plugin-socials/rsc    — server components
```

## Production configuration example

A complete configuration publishing from several collections to all four platforms, with templated copy, automatic image conversion, and scheduling. This is the shape of a real deployment.

```ts
import { payloadPluginSocials } from 'payload-plugin-socials'

const base = process.env.PUBLIC_URL!

payloadPluginSocials({
  encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!,

  authorize: async ({ req, scope }) => {
    const role = req.user?.role
    if (!role) return false
    if (scope === 'admin') return ['admin', 'owner'].includes(role)
    return ['admin', 'owner', 'editor', 'marketing'].includes(role)
  },

  // Publish from products, blog posts, and projects. Each resolver maps a
  // document into the channel-agnostic shape the composer understands.
  sources: {
    product: async ({ payload, id }) => {
      const p = await payload.findByID({ collection: 'products', id, depth: 1 })
      return {
        sourceId: String(p.id),
        sourceKind: 'product',
        baseTitle: p.title,
        baseDescription: p.description ?? '',
        link: `${base}/products/${p.slug}`,
        images: p.images.map((m, i) => ({
          url: m.url,
          role: i === 0 ? 'main' : 'detail',
          format: m.mimeType?.split('/')[1],
        })),
        metadata: { material: p.material, price: p.price, sku: p.sku },
      }
    },
    blogPost: async ({ payload, id }) => {
      const post = await payload.findByID({ collection: 'posts', id, depth: 1 })
      return {
        sourceId: String(post.id),
        sourceKind: 'blogPost',
        baseTitle: post.title,
        baseDescription: post.excerpt ?? '',
        link: `${base}/blog/${post.slug}`,
        images: post.heroImage?.url ? [{ url: post.heroImage.url, role: 'main' }] : [],
        metadata: { author: post.author?.name, published: post.publishedOn },
      }
    },
    project: async ({ payload, id }) => {
      const project = await payload.findByID({ collection: 'projects', id, depth: 1 })
      return {
        sourceId: String(project.id),
        sourceKind: 'project',
        baseTitle: project.title,
        baseDescription: project.summary ?? '',
        link: `${base}/work/${project.slug}`,
        images: (project.gallery ?? []).map((m) => ({ url: m.url, role: 'main' })),
        metadata: { location: project.location, completedAt: project.date },
      }
    },
  },

  // Operator-set default copy, per source kind.
  transformations: {
    product: {
      pinterestTitle: '{{ title }} | {{ metadata.material }}',
      instagramCaption: '{{ title }}\n\n{{ description | truncate:2000 }}',
    },
    '*': {
      facebookMessage: '{{ title }}\n\n{{ description | truncate:400 }}',
    },
  },

  // Convert non-JPEG media so Instagram and Facebook always get JPEG.
  assets: { autoConvert: true, renditionCollection: 'social-renditions' },

  admin: {
    mode: 'both',
    injectInto: [
      { collection: 'products', sourceKind: 'product' },
      { collection: 'posts', sourceKind: 'blogPost' },
      { collection: 'projects', sourceKind: 'project' },
    ],
  },

  platforms: {
    pinterest: {
      clientId: process.env.PINTEREST_APP_ID!,
      clientSecret: process.env.PINTEREST_APP_SECRET!,
      redirectUri: `${base}/api/socials/pinterest/oauth/callback`,
    },
    facebook: {
      appId: process.env.META_APP_ID!,
      appSecret: process.env.META_APP_SECRET!,
      systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
    },
    instagram: {
      appId: process.env.META_APP_ID!,
      appSecret: process.env.META_APP_SECRET!,
      systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
    },
  },

  scheduling: { internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY! },
})
```

## Documentation

- [Installation and configuration walkthrough](./docs/installation.md)
- [Pinterest setup](./docs/pinterest.md)
- [Instagram setup](./docs/instagram.md)
- [Facebook setup](./docs/facebook.md)
- [Google Business Profile setup](./docs/google-business-profile.md)

## License

MIT
