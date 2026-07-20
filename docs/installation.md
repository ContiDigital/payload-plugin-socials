# Installation and configuration

A complete walkthrough for wiring `payload-plugin-socials` into a Payload CMS 3 project: installation, the source resolvers that make your collections publishable, platform credentials, the image pipeline, scheduling, and deployment.

This guide is host-agnostic. Every example uses ordinary Payload collections (`products`, `posts`, `projects`), never a specific application's schema, so the patterns transfer to whatever your project looks like.

## Prerequisites

- A Payload CMS `^3.37.0` project.
- A database you run migrations against (Postgres, SQLite, or MongoDB).
- For scheduling, a long-running server process. Immediate publishing works anywhere.
- Developer credentials for the platforms you want: a Pinterest app, a Meta app, and/or a Google Cloud project. The per-platform guides cover obtaining these.

## Step 1: Install

```bash
pnpm add payload-plugin-socials
```

While the package is private, a pinned git dependency works:

```json
"payload-plugin-socials": "github:YourOrg/payload-plugin-socials#<commit-sha>"
```

If your deployment builds a Docker image, note the CI caveat in [Deployment](#deployment) before you push.

## Step 2: The encryption key

The plugin stores OAuth tokens encrypted with AES-256-GCM. Generate a 32-byte key and provide it as an environment variable in every environment:

```bash
openssl rand -hex 32
```

```ts
encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!,
```

Keep it stable. Changing it makes existing stored tokens undecryptable, forcing every platform to reconnect. To rotate deliberately, pass the previous key(s) in `previousEncryptionKeys` so tokens re-encrypt during the transition.

## Step 3: Access control

`authorize` gates both the REST API and the visibility of every admin surface. It receives `{ req, scope }`, where `scope` is `'admin'` (managing connections and templates) or `'publisher'` (composing and publishing). Return truthy to allow.

```ts
authorize: async ({ req, scope }) => {
  const role = req.user?.role
  if (!role) return false
  if (scope === 'admin') return ['admin', 'owner'].includes(role)
  return ['admin', 'owner', 'editor', 'marketing'].includes(role)
},
```

A user this function rejects sees nothing: no nav link, no `/admin/socials` route, no composer. There is no separate "hide the UI" flag; visibility follows `authorize`.

## Step 4: Source resolvers (the core of the integration)

A resolver turns one of your documents into a `SocialSourceContext`, the shape the composer, templates, and copy builders understand. You register one resolver per **source kind**. The composer then works identically for every kind you register.

The full context shape:

```ts
interface SocialSourceContext {
  sourceId: string // record id, stringified
  sourceKind: string // the kind key
  baseTitle: string // channel-agnostic title
  baseDescription: string // channel-agnostic body
  link: string // outbound URL
  images: SocialImage[] // preference order; the UI surfaces all
  videos?: SocialVideo[]
  modelLabel?: string | null
  metadata?: Record<string, unknown> // reachable in templates as {{ metadata.key }}
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

### A resolver per collection type

The design goal is that any collection can become a social source. Write a function per kind; register the kinds you want.

```ts
const base = process.env.PUBLIC_URL!

// A small helper most resolvers share: turn upload docs into SocialImages,
// skipping anything unpopulated or without a URL.
const imagesFrom = (docs: unknown[], role = 'main') =>
  docs.flatMap((d) =>
    d && typeof d === 'object' && 'url' in d && d.url
      ? [{ url: d.url as string, role, width: (d as any).width, height: (d as any).height,
           format: (d as any).mimeType?.split('/')[1] }]
      : [],
  )

sources: {
  product: async ({ payload, id }) => {
    const p = await payload.findByID({ collection: 'products', id, depth: 1 })
    return {
      sourceId: String(p.id),
      sourceKind: 'product',
      baseTitle: p.title,
      baseDescription: p.description ?? '',
      link: `${base}/products/${p.slug}`,
      images: [...imagesFrom([p.mainImage]), ...imagesFrom(p.gallery ?? [], 'detail')],
      metadata: { sku: p.sku, price: p.price, material: p.material },
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
      baseDescription: project.summary ?? '',
      link: `${base}/work/${project.slug}`,
      images: imagesFrom([project.hero, ...(project.gallery ?? [])]),
      metadata: { location: project.location, completedAt: project.date },
    }
  },
},
```

### Four rules that keep resolvers correct

1. **`metadata` is your extension surface.** Universal fields are `title`, `description`, `link` (and `baseTitle`/`baseDescription`, which alias the first two). Everything domain-specific goes in `metadata`, where it is reachable in templates as `{{ metadata.<key> }}` and appears in the template builder's field picker. Do not overload `baseTitle`/`baseDescription` with domain data.

2. **Set `format` on images.** The mime subtype drives pre-publish format validation, so an operator sees "Instagram does not accept webp" in the composer instead of a failed publish. It also feeds automatic conversion (Step 7).

3. **Image URLs must be publicly reachable.** Platforms fetch images server-side. Use CDN or public-bucket URLs. Localhost URLs, short-lived signed URLs, and IP-restricted origins will fail.

4. **Resolvers are just functions.** Query other collections, compute fields, follow relationships. A common pattern is enriching a parent from its children:

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
    link: `${base}/browse/${category.slug}`,       // link stays on the category page
    images: [
      ...imagesFrom([category.image]),
      ...members.docs.flatMap((p) => imagesFrom([p.mainImage])),  // publish a product shot
    ],
  }
},
```

## Step 5: Mount the composer

`admin.injectInto` adds the Socials tab to a collection and binds it to a resolver. `admin.mode` controls the standalone route and dashboard widget: `'route'`, `'dashboard'`, `'both'`, or `'headless'`.

```ts
admin: {
  mode: 'both',                    // /admin/socials route + dashboard widget
  route: '/socials',               // default
  injectInto: [
    { collection: 'products', sourceKind: 'product' },
    { collection: 'posts',    sourceKind: 'blogPost' },
    { collection: 'projects', sourceKind: 'project' },
  ],
},
```

The `sourceKind` on each entry must match a key in `sources`. The standalone composer at `/admin/socials` needs no resolver; it posts ad-hoc content directly.

For manual placement (you build the tabs yourself), omit `injectInto` and use the exported `getSocialsTab()` helper.

## Step 6: Platform credentials

Configure only the platforms you use; the rest stay disabled.

```ts
platforms: {
  pinterest: {
    clientId: process.env.PINTEREST_APP_ID!,
    clientSecret: process.env.PINTEREST_APP_SECRET!,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
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
```

Choosing an auth model:

- **Meta (Facebook + Instagram):** for a single-tenant install publishing to your own Page and IG account, a Business Manager **system-user token** is simplest. It never expires, needs no OAuth flow or App Review, and shows as connected automatically. For a multi-tenant product, supply `redirectUri` instead of `systemUserAccessToken` and each customer connects their own Page.
- **Pinterest:** OAuth only. Register the `redirectUri` verbatim in the Pinterest app, then a publisher clicks Connect once in `/admin/socials`.
- **Google Business Profile:** OAuth with the `business.manage` scope, gated by Google's Basic API Access approval per host.

Scopes, tokens, and platform quirks are in the per-platform guides linked from the README.

## Step 7: Image conversion (if your media is not JPEG)

Instagram accepts JPEG only; Facebook and GBP reject WebP and AVIF. If your upload pipeline stores WebP or anything non-JPEG, enable conversion:

```ts
assets: {
  autoConvert: true,
  renditionCollection: 'social-renditions',
},
```

The plugin detects the real format by magic bytes, transcodes to JPEG with sharp, uploads the rendition under a deterministic name (reused on re-publish), and sends the platform the rendition URL. Idempotency keys always derive from the original URL, so conversion never fragments post identity.

The rendition collection must not re-encode what the plugin uploads. Create a dedicated upload collection with **no** `formatOptions` and no image resizing:

```ts
export const SocialRenditions: CollectionConfig = {
  slug: 'social-renditions',
  access: { read: () => true, create: () => false, update: () => false, delete: () => false },
  admin: { hidden: true, description: 'JPEG renditions generated by the socials plugin.' },
  upload: { disableLocalStorage: true, mimeTypes: ['image/*'] }, // no formatOptions
  fields: [{ name: 'alt', type: 'text' }],
}
```

Register it in your `collections` array and with your storage adapter (S3 and similar) exactly like your main media collection, so its URLs are public.

## Step 8: Generate types, import map, and migration

```bash
pnpm payload generate:types
pnpm payload generate:importmap
pnpm payload migrate:create socials
pnpm payload migrate
```

- **`generate:importmap` is required.** The plugin's admin components (composer, template builder) are mounted through Payload's import map. Skip this and the Socials tab and template builder render as empty space, with no error. Re-run it in the build that ships your admin.
- **The migration** adds the `social-posts` and `social-templates` tables and the `socials-connections` global. Inspect it before applying, as with any schema change. The plugin never writes migrations itself.

## Step 9: Scheduling

The plugin defines the sweep task; you fire the trigger. Set the internal API key, then choose one mode:

```ts
scheduling: {
  internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY!,
  autoRun: { cron: '*/5 * * * *' },  // only if using native Payload Jobs
},
```

- **Native Payload Jobs:** set `autoRun.cron` and run a Payload jobs worker. Simplest on a long-running server.
- **External cron:** any scheduler `POST`s `/api/socials/internal/jobs/sweep` every few minutes with the `X-Socials-API-Key` header. Works with EventBridge, Vercel cron, GitHub Actions, or a plain crontab.
- **Worker loop:** import `sweepDueSocialPosts` and `runQueuedSocialsJobs` and call them yourself.

If your project globally disables Payload's `jobs.autoRun`, use the external or worker mode. A minimal external trigger, using AWS EventBridge invoking a Lambda that calls the endpoint:

```ts
const handler = async () => {
  await fetch(`${process.env.PUBLIC_URL}/api/socials/internal/jobs/sweep`, {
    method: 'POST',
    headers: { 'x-socials-api-key': process.env.SOCIALS_INTERNAL_API_KEY! },
  })
}
```

Scheduled posts are `queued` rows with a future `scheduledAt`; the sweep publishes the due ones. It is idempotent, so overlapping fires cannot double-publish.

## Step 10: Connect and publish

1. Deploy (or run locally), then open `/admin/socials`.
2. On the Connections tab, connect each platform. Meta system-user connections already show as connected; Pinterest and GBP require a one-time OAuth click.
3. Open a document in a collection you injected the tab into, go to the Socials tab, fill in a platform's fields, preview, and publish.
4. Confirm the post exists on the platform, then optionally delete it from the composer's history list.

## Templates

Templates are staff-editable copy variants, created in the `Social Templates` collection. Each template is bound to a source kind, so it only appears in the composer when publishing from that collection. Build copy with the field-picker (scoped to that collection's real fields, discovered from a sample record) and a live preview, or toggle raw mode to write `{{ }}` strings directly. Mark a template "default for this collection" and it auto-applies.

Config `transformations` remain the code-level default; templates layer on top of them. Precedence, most specific first: a chosen template, then a default template for the kind, then `transformations`, then the built-in copy builders.

## Deployment

- **Private git dependency:** if your image build runs `pnpm install`, it needs a GitHub token wherever the install happens. For Docker, pass a build secret and rewrite the remote before install:

  ```dockerfile
  RUN --mount=type=secret,id=gh_token \
      git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/" \
   && pnpm i --frozen-lockfile
  ```

  A runtime-only token does not help; it must reach the build stage.

- **Import map in the build:** run `generate:importmap` in the same build that ships the admin, or the plugin's admin components render blank in production.

- **Public asset URLs:** the platforms fetch images and rendition URLs from outside your network. Ensure they are public (CDN or public bucket), not localhost or short-lived signed URLs.

- **Secrets:** provide `SOCIALS_ENCRYPTION_KEY`, the platform credentials, and `SOCIALS_INTERNAL_API_KEY` through your secret manager. The encryption key must be identical across every instance of an environment.

## Troubleshooting

- **The Socials tab or template builder is blank.** The import map is stale. Run `pnpm payload generate:importmap` and rebuild.
- **A publish fails with a format error.** The image is a format the platform rejects (commonly WebP on Instagram). Enable `assets.autoConvert` with a rendition collection (Step 7), or serve JPEG.
- **A publish fails fetching the image.** The URL is not publicly reachable. Check for localhost, expiring signed URLs, or IP allowlists.
- **Pinterest connects but publishing 403s.** The connected account may lack a required scope, or the Pinterest app may be in Trial Access. See [docs/pinterest.md](./docs/pinterest.md).
- **Scheduled posts never publish.** No sweep trigger is firing. Confirm your cron or worker is calling `/api/socials/internal/jobs/sweep` (Step 9).
