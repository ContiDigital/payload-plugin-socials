# payload-plugin-socials

Organic social publishing for [Payload CMS](https://payloadcms.com) v3.

Compose, preview, schedule, and publish posts to Pinterest, Instagram, Facebook, and Google Business Profile from inside Payload's admin panel, driven by your own content. Real API integrations for every platform, no copy-paste export tabs.

**Extracted from production at [Fine's Gallery](https://finesgallery.com).** This plugin began as the Pinterest publishing engine behind Fine's Gallery, a luxury marble and bronze retailer, and was generalized into a four-platform plugin. The Pinterest path has run in production against real catalogs; Instagram and Facebook are validated end to end against the live Meta Graph API.

Anything Fine's-specific (segments, catalog feeds, product enrichment) stays in the host application. The plugin ships only the reusable machinery: the composer, the platform adapters, encrypted token storage, scheduling, and templates.

## What the plugin does

When enabled, the plugin:

1. Adds a **Socials** tab to any collection you choose, with a per-record composer: pick a platform, pick a destination (board, Page, IG account, location), fill in copy and media, preview, and publish or schedule.
2. Mounts a standalone composer at `/admin/socials` for posting ad-hoc content that isn't tied to a document.
3. Registers a `social-posts` collection (one audited, idempotent row per publish) and a `social-templates` collection (reusable, per-collection copy templates).
4. Stores OAuth tokens encrypted at rest (AES-256-GCM) in a hidden `socials-connections` global.
5. Exposes a full REST surface under `/api/socials/*`: OAuth, destination discovery, preview, publish, history, delete, and scheduling.
6. Defines the scheduled-publish, insights-refresh, and connection-refresh tasks. You wire the trigger (Payload cron, EventBridge, a worker loop, whatever you run).

Everything is driven by **source resolvers** you write: small functions that map one of your documents (a product, a blog post, a project) into a channel-agnostic shape the composer understands. Register a resolver per collection kind and the composer works identically across all of them.

## Requirements

- Payload CMS `^3.37.0`
- Node.js `^18.20.2 || >=20.9.0`
- **A long-running server process** for scheduling (EC2, ECS, a VPS, a worker). Immediate publishing works anywhere; see [Scheduling](#scheduling).

```bash
pnpm add payload-plugin-socials
```

## Platform maturity

| Platform                    | Status         | Notes                                                                                                                                                                                                                                                                                        |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pinterest**               | Production     | The originating integration. OAuth, boards, pins (image + video), insights.                                                                                                                                                                                                                  |
| **Facebook Pages**          | Validated live | Text, link, photo, multi-photo, video. Verified against the live Graph API.                                                                                                                                                                                                                  |
| **Instagram Business**      | Validated live | Image, video, Reels, Stories, Carousel. Verified against the live Graph API.                                                                                                                                                                                                                 |
| **Google Business Profile** | Experimental   | LocalPosts (Standard, Event, Offer, Alert) implemented to spec, not yet verified against the live API. GBP posting requires Google's Basic API Access approval per host, so validate in your own approved project. See [docs/google-business-profile.md](./docs/google-business-profile.md). |

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

## Publishing

From a document's Socials tab or the standalone composer: choose a platform, choose a destination, review the preview, and publish. Every publish is idempotent. The plugin computes a per-platform key from `(platform, source, destination, primary asset)` and upserts a `social-posts` row on it, so publishing the same content twice returns the existing post instead of duplicating it.

Programmatic publishing is available too:

```ts
import { composeAndPublish } from 'payload-plugin-socials'
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

## Documentation

- [Installation and configuration walkthrough](./docs/installation.md)
- [Pinterest setup](./docs/pinterest.md)
- [Instagram setup](./docs/instagram.md)
- [Facebook setup](./docs/facebook.md)
- [Google Business Profile setup](./docs/google-business-profile.md)

## License

MIT
