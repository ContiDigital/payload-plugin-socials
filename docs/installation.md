# Installation and configuration

A complete, production-shaped walkthrough for wiring `payload-plugin-socials` into a Payload CMS 3 project. It follows the same shape as a real deployment: multiple content types as sources, a category that publishes its products' imagery, format-safe media, and scheduling driven by cloud infrastructure.

Every example uses ordinary collections (`products`, `categories`, `posts`, `projects`) rather than any one application's schema, so the patterns transfer to your project. Where a step maps to something Fine's Gallery does in production, that is called out.

## What a full installation looks like

By the end of this guide you will have:

1. The plugin installed and configured with an encryption key and access control.
2. Source resolvers for several content types, including a category that pulls in its member products' images.
3. A dedicated rendition collection so non-JPEG media publishes cleanly to Instagram and Facebook.
4. The Socials tab on each source collection, plus the standalone composer.
5. Pinterest connected via OAuth and Meta connected via a system-user token.
6. Types, the admin import map, and a migration generated.
7. Scheduling wired to a cloud scheduler (an AWS EventBridge example, generalizable to any cron), so scheduled posts publish automatically.

## Prerequisites

- A Payload CMS `^3.37.0` project on a long-running host (for scheduling).
- A database you run migrations against.
- Developer credentials for the platforms you want:
  - **Pinterest:** an app in the [Pinterest developer portal](https://developers.pinterest.com/) with a client ID and secret, and a registered redirect URI.
  - **Meta (Facebook + Instagram):** a Meta app, a Facebook Page, an Instagram Business account linked to that Page, and a Business Manager **system-user token** with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, and `instagram_manage_insights`. See [docs/facebook.md](./facebook.md) and [docs/instagram.md](./instagram.md).
  - **Google Business Profile (optional):** a Google Cloud project with Basic API Access approved. See [docs/google-business-profile.md](./google-business-profile.md).

Generate your encryption and internal API keys now:

```bash
openssl rand -hex 32   # SOCIALS_ENCRYPTION_KEY
openssl rand -hex 24   # SOCIALS_INTERNAL_API_KEY
```

Put every secret in your environment / secret manager:

```
SOCIALS_ENCRYPTION_KEY=...
SOCIALS_INTERNAL_API_KEY=...
PINTEREST_APP_ID=...
PINTEREST_APP_SECRET=...
META_APP_ID=...
META_APP_SECRET=...
META_SYSTEM_USER_TOKEN=...
PUBLIC_URL=https://your-site.com
```

## Step 1: Install the package

```bash
pnpm add payload-plugin-socials
```

While the package is private, pin a git dependency:

```json
"payload-plugin-socials": "github:YourOrg/payload-plugin-socials#<commit-sha>"
```

If your deployment builds a Docker image, read [Deployment](#deployment) before pushing: a private git dependency needs a build-time token.

## Step 2: Scaffold the plugin config

Create a dedicated module for the plugin so the resolvers have room to grow. This mirrors how a production app keeps its social wiring in one place.

```ts
// src/plugins/socials.ts
import type { Plugin } from 'payload'
import { payloadPluginSocials } from 'payload-plugin-socials'
import {
  productResolver,
  categoryResolver,
  blogResolver,
  projectResolver,
} from './socials-resolvers'

const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')

export const SocialsPlugin: Plugin = payloadPluginSocials({
  encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!,

  // scope is 'admin' (connections + templates) or 'publisher' (compose + publish).
  authorize: async ({ req, scope }) => {
    const role = req.user?.role
    if (!role) return false
    if (scope === 'admin') return ['admin', 'owner'].includes(role)
    return ['admin', 'owner', 'editor', 'marketing'].includes(role)
  },

  assets: { autoConvert: true, renditionCollection: 'social-renditions' },

  sources: {
    product: productResolver,
    category: categoryResolver,
    blogPost: blogResolver,
    project: projectResolver,
  },

  admin: {
    mode: 'both',
    injectInto: [
      { collection: 'products', sourceKind: 'product' },
      { collection: 'categories', sourceKind: 'category' },
      { collection: 'posts', sourceKind: 'blogPost' },
      { collection: 'projects', sourceKind: 'project' },
    ],
  },

  platforms: {
    pinterest: {
      clientId: process.env.PINTEREST_APP_ID!,
      clientSecret: process.env.PINTEREST_APP_SECRET!,
      redirectUri: `${base()}/api/socials/pinterest/oauth/callback`,
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

Add `SocialsPlugin` to your `plugins` array in `payload.config.ts`.

> **Graceful disable.** If `SOCIALS_ENCRYPTION_KEY` may be absent in some environments (a migrate step before secrets are wired, for example), pass `disabled: !process.env.SOCIALS_ENCRYPTION_KEY`. The config still builds; the plugin just stays inactive.

## Step 3: Write the source resolvers

A resolver maps one of your documents into a `SocialSourceContext`, the shape the composer, templates, and copy builders understand. This is the heart of the integration. Put them in one module and share a couple of helpers.

```ts
// src/plugins/socials-resolvers.ts
import type { SourceContextResolver, SocialImage } from 'payload-plugin-socials'

const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')

// Turn upload docs into SocialImages, skipping anything unpopulated or urlless.
// `format` (the mime subtype) drives pre-publish format validation and conversion.
const imagesFrom = (docs: unknown[], role = 'main'): SocialImage[] =>
  docs.flatMap((d) =>
    d && typeof d === 'object' && 'url' in d && (d as any).url
      ? [
          {
            url: (d as any).url as string,
            role,
            width: (d as any).width,
            height: (d as any).height,
            format: (d as any).mimeType?.split('/')[1],
          },
        ]
      : [],
  )
```

### Products

The bread-and-butter source. Note `metadata`: every key is reachable in templates as `{{ metadata.<key> }}` and appears in the template builder's field picker.

```ts
export const productResolver: SourceContextResolver = async ({ payload, id }) => {
  const p = await payload.findByID({ collection: 'products', id, depth: 1 })
  return {
    sourceId: String(p.id),
    sourceKind: 'product',
    baseTitle: p.title,
    baseDescription: p.description ?? '',
    link: `${base()}/products/${p.slug}`,
    // If you have a watermark-free image set, list it first.
    images: [...imagesFrom([p.mainImage]), ...imagesFrom(p.gallery ?? [], 'detail')],
    videos: (p.videos ?? []).flatMap((v: any) => (v?.url ? [{ url: v.url }] : [])),
    metadata: { sku: p.sku, price: p.price, material: p.material },
  }
}
```

### Categories that publish their products' images

This is the pattern to publish a collection page while offering the imagery of the products inside it. The resolver queries the member products and adds one image each to the pool; the post `link` still points at the category page. Fine's Gallery uses exactly this so staff can post a product shot that drives traffic to a category.

```ts
export const categoryResolver: SourceContextResolver = async ({ payload, id }) => {
  const category = await payload.findByID({ collection: 'categories', id, depth: 1 })

  // Pull the products in this category, populated enough to read their images.
  const members = await payload.find({
    collection: 'products',
    where: { categories: { in: [id] } },
    depth: 1,
    limit: 24, // cap so the composer media grid stays usable
  })

  const memberImages = members.docs.flatMap((p: any) =>
    imagesFrom([p.mainImage], 'product').slice(0, 1),
  )

  return {
    sourceId: String(category.id),
    sourceKind: 'category',
    baseTitle: category.title,
    baseDescription: category.description ?? '',
    link: `${base()}/browse/${category.slug}`, // link stays on the category page
    images: [...imagesFrom([category.image]), ...memberImages],
    metadata: { productCount: members.totalDocs },
  }
}
```

The operator opens a category, sees its own image plus a grid of its products' images, picks the one that sells best, and publishes. The same shape works for promotions, look-books, or any parent-of-many record.

### Blog posts and projects

Any collection can be a source. Repeat the pattern with the fields that matter for each.

```ts
export const blogResolver: SourceContextResolver = async ({ payload, id }) => {
  const post = await payload.findByID({ collection: 'posts', id, depth: 1 })
  return {
    sourceId: String(post.id),
    sourceKind: 'blogPost',
    baseTitle: post.title,
    baseDescription: post.excerpt ?? '',
    link: `${base()}/blog/${post.slug}`,
    images: imagesFrom([post.heroImage]),
    metadata: { author: post.author?.name, published: post.publishedOn },
  }
}

export const projectResolver: SourceContextResolver = async ({ payload, id }) => {
  const project = await payload.findByID({ collection: 'projects', id, depth: 1 })
  return {
    sourceId: String(project.id),
    sourceKind: 'project',
    baseTitle: project.title,
    baseDescription: project.summary ?? '',
    link: `${base()}/work/${project.slug}`,
    images: imagesFrom([project.hero, ...(project.gallery ?? [])]),
    metadata: { location: project.location, completedAt: project.date },
  }
}
```

### Resolver rules that matter in production

1. **`metadata` is your extension surface.** Universal fields are `title`, `description`, `link`. Everything domain-specific goes in `metadata`, reachable as `{{ metadata.<key> }}`. Do not overload `baseTitle`/`baseDescription` with domain data.
2. **Set `format` on images.** It flags a WebP-on-Instagram post in the composer instead of failing at publish, and it feeds automatic conversion (Step 4).
3. **Image URLs must be publicly fetchable.** Platforms fetch server-side. Use CDN or public-bucket URLs, never localhost or short-lived signed URLs.
4. **Resolvers are `async`.** Query other collections, follow relationships, compute values. The full Payload API is available.

## Step 4: The rendition collection

Instagram accepts JPEG only; Facebook and GBP reject WebP and AVIF. With `assets.autoConvert` enabled (Step 2), the plugin transcodes non-JPEG images to JPEG and uploads the result to a rendition collection. That collection must **not** re-encode what the plugin uploads, so give it no `formatOptions`:

```ts
// src/collections/SocialRenditions.ts
import type { CollectionConfig } from 'payload'

export const SocialRenditions: CollectionConfig = {
  slug: 'social-renditions',
  access: { read: () => true, create: () => false, update: () => false, delete: () => false },
  admin: {
    hidden: true,
    description: 'JPEG renditions generated by the socials plugin for platforms that reject WebP.',
  },
  upload: { disableLocalStorage: true, mimeTypes: ['image/*'] }, // no formatOptions, no imageSizes
  fields: [{ name: 'alt', type: 'text' }],
}
```

Add it to your `collections` array, and register it with your storage adapter exactly like your main media collection so its URLs are public. If your media collection uses `@payloadcms/storage-s3`, add `social-renditions` to the same `collections` map with its own prefix.

> **Why a separate collection.** Pointing `renditionCollection` at a media collection that converts uploads to WebP would silently convert the plugin's JPEG right back, defeating the purpose. A dedicated, format-free collection is the fix.

## Step 5: Generate types, import map, and migration

```bash
pnpm payload generate:types
pnpm payload generate:importmap
pnpm payload migrate:create socials
pnpm payload migrate
```

- **`generate:importmap` is required.** The composer and template builder mount through Payload's import map. Skip it and those surfaces render blank, with no error. Re-run it in the build that ships your admin.
- **Inspect the migration** before applying. It adds the `social-posts` and `social-templates` tables and the `socials-connections` global. The plugin never writes migrations itself; you own them.

## Step 6: Connect the platforms

1. Start the app and open `/admin/socials`.
2. On the **Connections** tab:
   - **Facebook and Instagram** show as connected automatically (system-user token). Nothing to click.
   - **Pinterest** shows a Connect button. Click it, complete the OAuth flow. The refresh token is stored encrypted and rotates automatically. (Register the redirect URI in the Pinterest app first: `${PUBLIC_URL}/api/socials/pinterest/oauth/callback`.)
3. Open a record in one of your source collections, go to the **Socials** tab, fill in a platform's fields, preview, and publish. Confirm the post on the platform, then delete it from the composer's history if it was a test.

## Step 7: Scheduling

Scheduled posts are `queued` rows with a future `scheduledAt`. The plugin's sweep task publishes the due ones; you provide the trigger that runs the sweep every few minutes. Pick the mode that matches your infrastructure.

### The endpoint

Every mode ultimately calls:

```
POST {PUBLIC_URL}/api/socials/internal/jobs/sweep
Header: X-Socials-API-Key: <SOCIALS_INTERNAL_API_KEY>
```

### Mode A: Cloud scheduler (AWS EventBridge shown; any cron works)

This is the production pattern: a scheduled event invokes a small function that calls the sweep endpoint. The example is AWS EventBridge plus a Lambda, but the shape is identical for Vercel Cron, a GitHub Actions schedule, Google Cloud Scheduler, or a plain crontab: **on a timer, POST the endpoint with the API key header.**

The function:

```ts
// A tiny handler that pings the sweep endpoint. Deploy it however you deploy functions.
export const handler = async () => {
  const res = await fetch(`${process.env.PUBLIC_URL}/api/socials/internal/jobs/sweep`, {
    method: 'POST',
    headers: { 'x-socials-api-key': process.env.SOCIALS_INTERNAL_API_KEY! },
  })
  if (!res.ok) throw new Error(`Socials sweep failed: ${res.status} ${await res.text()}`)
  return { statusCode: 200 }
}
```

Wiring it on AWS with SST (Terraform / CDK / Pulumi follow the same three resources: a function, a schedule rule, a target):

```ts
const sweep = new sst.aws.Function('SocialsSweep', {
  handler: 'src/functions/socials-sweep.handler',
  environment: {
    PUBLIC_URL: process.env.PUBLIC_URL!,
    SOCIALS_INTERNAL_API_KEY: process.env.SOCIALS_INTERNAL_API_KEY!,
  },
})

const rule = new aws.cloudwatch.EventRule('SocialsSweepSchedule', {
  scheduleExpression: 'rate(5 minutes)',
})

new aws.lambda.Permission('SocialsSweepPermission', {
  action: 'lambda:InvokeFunction',
  function: sweep.arn,
  principal: 'events.amazonaws.com',
  sourceArn: rule.arn,
})

new aws.cloudwatch.EventTarget('SocialsSweepTarget', { rule: rule.name, arn: sweep.arn })
```

The equivalent as a plain crontab entry on any box that can reach your site:

```
*/5 * * * * curl -fsS -X POST "$PUBLIC_URL/api/socials/internal/jobs/sweep" -H "x-socials-api-key: $SOCIALS_INTERNAL_API_KEY"
```

The sweep is idempotent, so an overlapping fire cannot double-publish. Publish latency is roughly the schedule interval, so 5 minutes is a good default.

### Mode B: Native Payload Jobs

If your app runs Payload's job worker and does not disable `autoRun`, let the plugin schedule itself:

```ts
scheduling: {
  internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY!,
  autoRun: {
    cron: '*/5 * * * *',                 // the sweep
    insightsRefreshCron: '0 * * * *',    // optional: pull engagement hourly
    connectionRefreshCron: '0 3 * * *',  // optional: refresh tokens nightly
  },
},
```

### Mode C: Worker loop

Call the exported functions from your own long-running process:

```ts
import { sweepDueSocialPosts, runQueuedSocialsJobs } from 'payload-plugin-socials'

setInterval(
  async () => {
    await sweepDueSocialPosts(payload, options)
    await runQueuedSocialsJobs(payload, options)
  },
  5 * 60 * 1000,
)
```

Scheduling from the composer is safe regardless of mode: a past or near-past time is rejected instead of published immediately, and queued posts show their time and can be cancelled from the history list.

## Step 8: Templates (optional, recommended)

Create reusable copy templates in the **Social Templates** collection. Each is bound to a source kind, so a product template only appears when composing from products. Build copy with the field picker (scoped to that collection's real fields, discovered from a sample record) and a live preview, or toggle raw mode to write `{{ }}` strings. Mark one "default for this collection" and it auto-applies.

Config `transformations` (in the plugin options) are the code-level default; templates layer on top. Precedence, most specific first: a chosen template, then a default template for the kind, then `transformations`, then the built-in copy builders.

```ts
// In the plugin config: operator-set defaults per source kind.
transformations: {
  product: {
    pinterestTitle: '{{ title }} | {{ metadata.material }}',
    instagramCaption: '{{ title }}\n\n{{ description | truncate:2000 }}',
  },
  '*': { facebookMessage: '{{ title }}\n\n{{ description | truncate:400 }}' },
},
```

## Deployment

- **Private git dependency + Docker.** If your image build runs `pnpm install`, it needs a GitHub token there. Pass a build secret and rewrite the remote before install:

  ```dockerfile
  RUN --mount=type=secret,id=gh_token \
      git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/" \
   && pnpm i --frozen-lockfile
  ```

  A runtime-only token does not help; it must reach the build stage.

- **Import map in the build.** Run `generate:importmap` in the same build that ships the admin, or the composer and template builder render blank in production.

- **Public asset URLs.** The platforms fetch images and rendition URLs from outside your network. Ensure they are public (CDN or public bucket), not localhost or short-lived signed URLs.

- **Secrets.** Provide `SOCIALS_ENCRYPTION_KEY`, the platform credentials, and `SOCIALS_INTERNAL_API_KEY` through your secret manager. The encryption key must be identical across every instance of an environment; changing it orphans stored tokens.

- **Migrations.** The generated migration ships with your build and runs against the production database as part of your normal deploy.

## Production checklist

- [ ] `SOCIALS_ENCRYPTION_KEY` (32 bytes) set in every environment, stable per environment.
- [ ] Meta system-user token generated with the six scopes; verify `expires_at: 0` in the Graph token debugger.
- [ ] Pinterest redirect URI registered; a publisher completed the one-time Connect on production.
- [ ] `assets.autoConvert` on with a dedicated, format-free rendition collection (if your media is not JPEG).
- [ ] Rendition and media URLs publicly fetchable from outside your network.
- [ ] `generate:importmap` ran in the build that ships the admin.
- [ ] Migration generated, inspected, applied.
- [ ] A scheduling trigger is firing (schedule a post 5 minutes out and watch it publish).
- [ ] Smoke test per platform with real content, then delete.

## Troubleshooting

- **The Socials tab or template builder is blank.** Stale import map. Run `pnpm payload generate:importmap` and rebuild.
- **A publish fails with a format error.** The image is a format the platform rejects (commonly WebP on Instagram). Enable `assets.autoConvert` with a rendition collection (Step 4), or serve JPEG.
- **A publish fails fetching the image.** The URL is not publicly reachable. Check for localhost, expiring signed URLs, or IP allowlists.
- **Pinterest connects but publishing 403s.** The account may lack a required scope, or the app may be in Trial Access. See [docs/pinterest.md](./pinterest.md).
- **Scheduled posts never publish.** No sweep trigger is firing. Confirm your scheduler is POSTing `/api/socials/internal/jobs/sweep` (Step 7).
- **A category composer shows no product images.** The `where` clause in the category resolver does not match your products-to-categories relationship. Adjust the field name to your schema.
