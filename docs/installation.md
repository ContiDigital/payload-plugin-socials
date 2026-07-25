# Installation and configuration

A production-shaped walkthrough for wiring `payload-plugin-socials` into a Payload CMS 3 project: arbitrary source types, format-safe media, host-owned migrations, and scheduling through either Payload Jobs or external infrastructure.

The guide uses two deliberately neutral placeholders:

| Example                                         | What it demonstrates                                                    | Replace it with                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `content` collection / `entry` source kind      | Publishing one record with its own copy and media                       | Any independently publishable collection in your application                  |
| `campaigns` collection / `campaign` source kind | Publishing an aggregate record with media gathered from related records | Any collection, landing page, bundle, series, or other parent-of-many concept |

These collection names and fields are illustrative. You do not need to create them. Map your existing collections into the same `SocialSourceContext` contract.

## What a full installation looks like

By the end of this guide you will have:

1. The plugin installed and configured with an encryption key and access control.
2. Source resolvers for both a direct record and an aggregate record that gathers media from related content.
3. A dedicated rendition collection so non-JPEG media publishes cleanly to Instagram and Facebook.
4. The Socials tab on each source collection, plus the standalone composer.
5. Pinterest connected via OAuth and Meta connected via a system-user token.
6. Types, the admin import map, and a migration generated.
7. Scheduling wired to a cloud scheduler (an AWS EventBridge example, generalizable to any cron), so scheduled posts publish automatically.

## Prerequisites

- Payload CMS `^3.84.1` on Node.js `>=22.12.0`.
- A deployment capable of running Payload Jobs, or an HTTPS deployment reachable by an external scheduler. A permanently running web process is not required when the scheduler endpoint drains jobs inline.
- A database you run migrations against.
- Developer credentials for the platforms you want:
  - **Pinterest:** an app in the [Pinterest developer portal](https://developers.pinterest.com/) with a client ID and secret, and a registered redirect URI.
  - **Meta (Facebook + Instagram):** a Meta app, a Facebook Page, an Instagram Business account linked to that Page, and a Business Manager **system-user token** with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, and `instagram_manage_insights`. See [docs/facebook.md](./facebook.md) and [docs/instagram.md](./instagram.md).
  - **Google Business Profile (optional):** a Google Cloud project with Basic API Access approved. See [docs/google-business-profile.md](./google-business-profile.md).

> **Meta visibility gate:** New Meta apps start in **Development mode**. Meta can accept a Facebook or Instagram publish and return a real object ID while the resulting test post is visible only to people with a role on the app, such as its administrators, developers, and testers. Public publishing requires the app/use case to be **Live**, with the required permissions and access levels approved for the accounts it serves. Before switching to Live, remove test content you do not want exposed; Meta documents that Development-mode data can become visible to non-role users after the switch. See [Meta App Modes](https://developers.facebook.com/documentation/development/build-and-test/app-modes), [Facebook setup](./facebook.md#4-development-mode-is-not-public-publishing), and [Instagram setup](./instagram.md#4-development-mode-is-not-public-publishing).

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

## Step 2: Scaffold the plugin config

Create a dedicated module for the plugin so the resolvers have room to grow. This mirrors how a production app keeps its social wiring in one place.

```ts
// src/plugins/socials.ts
import type { PayloadPluginSocialsConfig } from 'payload-plugin-socials'
import { payloadPluginSocials } from 'payload-plugin-socials'
import { campaignResolver, entryResolver } from './socials-resolvers'

const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')

export const socialsOptions = {
  encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!,
  authCollection: 'users',

  // scope is 'admin' (connections + templates) or 'publisher' (compose + publish).
  authorize: async ({ req, scope }) => {
    const role = req.user?.role
    if (!role) return false
    if (scope === 'admin') return ['admin', 'owner'].includes(role)
    return ['admin', 'owner', 'editor', 'marketing'].includes(role)
  },

  assets: {
    autoConvert: true,
    remoteFetchTimeoutMs: 15_000,
    renditionCollection: 'social-renditions',
  },

  sources: {
    entry: entryResolver,
    campaign: campaignResolver,
  },

  admin: {
    mode: 'both',
    injectInto: [
      { collection: 'content', sourceKind: 'entry', label: 'Content' },
      { collection: 'campaigns', sourceKind: 'campaign', label: 'Campaigns' },
    ],
  },

  platforms: {
    pinterest: {
      clientId: process.env.PINTEREST_APP_ID!,
      clientSecret: process.env.PINTEREST_APP_SECRET!,
      enabled: true,
      redirectUri: `${base()}/api/socials/pinterest/oauth/callback`,
    },
    facebook: {
      appId: process.env.META_APP_ID!,
      appSecret: process.env.META_APP_SECRET!,
      enabled: true,
      systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
    },
    instagram: {
      appId: process.env.META_APP_ID!,
      appSecret: process.env.META_APP_SECRET!,
      enabled: true,
      systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
    },
  },

  scheduling: { internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY! },
} satisfies PayloadPluginSocialsConfig

export const SocialsPlugin = payloadPluginSocials(socialsOptions)
```

Add `SocialsPlugin` to your `plugins` array in `payload.config.ts`.

> **Graceful disable.** If `SOCIALS_ENCRYPTION_KEY` may be absent in some environments (a migrate step before secrets are wired, for example), pass `disabled: !process.env.SOCIALS_ENCRYPTION_KEY`. The plugin keeps its collections/global in the schema but hides them, denies access, removes hooks, and omits all endpoints, tasks, and admin surfaces. Keep the same `sources` keys and `authCollection` in enabled and disabled environments so generated migrations remain stable.

## Step 3: Write the source resolvers

A resolver maps one of your documents into a `SocialSourceContext`, the shape the composer, templates, and copy builders understand. This is the heart of the integration. Put them in one module and share a couple of helpers.

```ts
// src/plugins/socials-resolvers.ts
import type { SocialImage, SocialImageFormat, SourceContextResolver } from 'payload-plugin-socials'

const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '')

// Turn upload docs into SocialImages, skipping anything unpopulated or urlless.
// `format` (the mime subtype) drives pre-publish format validation and conversion.
const IMAGE_FORMATS = new Set<SocialImageFormat>([
  'avif',
  'bmp',
  'gif',
  'jpeg',
  'png',
  'tiff',
  'webp',
])

const imagesFrom = (docs: unknown[], role = 'main'): SocialImage[] =>
  docs.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const doc = value as Record<string, unknown>
    if (typeof doc.url !== 'string' || !doc.url) return []
    const candidate =
      typeof doc.mimeType === 'string' ? doc.mimeType.split('/')[1]?.toLowerCase() : undefined
    const format =
      candidate && IMAGE_FORMATS.has(candidate as SocialImageFormat)
        ? (candidate as SocialImageFormat)
        : undefined
    return [
      {
        format,
        height: typeof doc.height === 'number' ? doc.height : undefined,
        role,
        url: doc.url,
        width: typeof doc.width === 'number' ? doc.width : undefined,
      },
    ]
  })
```

### A direct record source

The most common resolver publishes one document with its own copy, destination, media, and application-specific metadata. Every `metadata` key is reachable in templates as `{{ metadata.<key> }}` and appears in the template builder's field picker.

```ts
export const entryResolver: SourceContextResolver = async ({ payload, id }) => {
  const entry = await payload.findByID({ collection: 'content', id, depth: 1 })

  return {
    sourceId: String(entry.id),
    sourceKind: 'entry',
    baseTitle: entry.title,
    baseDescription: entry.summary ?? '',
    link: `${base()}/content/${entry.slug}`,
    images: [...imagesFrom([entry.hero]), ...imagesFrom(entry.media ?? [], 'detail')],
    videos: (entry.videos ?? []).flatMap((value) => {
      if (!value || typeof value !== 'object' || !('url' in value)) return []
      return typeof value.url === 'string' ? [{ url: value.url }] : []
    }),
    metadata: {
      audience: entry.audience,
      locale: entry.locale,
      tags: entry.tags,
    },
  }
}
```

### An aggregate source with related media

Resolvers can query any data available through Payload. This pattern publishes an aggregate record while offering its own cover plus one image from each related record. The outbound `link` still points to the aggregate page.

```ts
export const campaignResolver: SourceContextResolver = async ({ payload, id }) => {
  const campaign = await payload.findByID({ collection: 'campaigns', id, depth: 1 })

  // Replace this relationship field with the equivalent in your schema.
  const related = await payload.find({
    collection: 'content',
    where: { campaigns: { in: [id] } },
    depth: 1,
    limit: 24,
  })

  const relatedImages = related.docs.flatMap((entry) =>
    imagesFrom([entry.hero], 'related').slice(0, 1),
  )

  return {
    sourceId: String(campaign.id),
    sourceKind: 'campaign',
    baseTitle: campaign.title,
    baseDescription: campaign.summary ?? '',
    link: `${base()}/campaigns/${campaign.slug}`,
    images: [...imagesFrom([campaign.cover]), ...relatedImages],
    metadata: {
      itemCount: related.totalDocs,
      theme: campaign.theme,
    },
  }
}
```

The operator opens a campaign, sees its own cover plus a bounded media pool from related records, chooses the strongest asset, and publishes without changing the destination URL. The same resolver shape works for any direct, aggregate, or computed source. Register additional source kinds by adding another resolver and `admin.injectInto` entry; the plugin itself has no closed list of source types.

### Resolver rules that matter in production

1. **`metadata` is your extension surface.** Universal context fields are `baseTitle`, `baseDescription`, and `link`; template aliases expose `title` and `description`. Put domain-specific data in `metadata`, reachable as `{{ metadata.<key> }}`.
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

> **Why a separate collection.** Pointing `renditionCollection` at a media collection that converts uploads to WebP would silently convert the plugin's JPEG right back, defeating the purpose. A dedicated, format-free collection is the solution.

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

### Meta: Development mode is not public publishing

Meta's [App Modes documentation](https://developers.facebook.com/documentation/development/build-and-test/app-modes) distinguishes API testing from public distribution:

| Meta app state                               | What a successful publish proves                                                          | Expected visibility                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Development**                              | The token, asset assignment, payload, and Graph API transport worked for an app-role user | Test content is limited to app administrators, developers, testers, and other role users |
| **Live** with the required permission access | The integration is eligible to serve the intended accounts                                | Content can be validated from an ordinary, non-role account                              |

A returned Page post ID, Instagram container ID, or `media_publish` ID is therefore not proof that the public can see the content.

Before production:

1. Complete the App Review, Business Verification, and permission-access work shown for your app's current use case.
2. Remove Development-mode canaries you do not want to become public. For Instagram, remove them in the Instagram app because this integration has no upstream delete capability.
3. Switch the app/use case to **Live** in the Meta App Dashboard.
4. Revalidate the token, its granular asset assignments, and the required permissions.
5. Publish a fresh canary and verify its canonical URL while logged out or from an account with no role on the app, Meta Business, Page, or Instagram account.

See the platform-specific [Facebook](./facebook.md#4-development-mode-is-not-public-publishing) and [Instagram](./instagram.md#4-development-mode-is-not-public-publishing) checklists.

### Connect and test

1. Start the app and open `/admin/socials`.
2. On the **Connections** tab:
   - **Facebook and Instagram** use the configured system-user token. Verify the token, assigned assets, permissions, and actual expiry in Meta's tooling before relying on it.
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

The Lambda handler is plain Node.js and has no framework dependency:

```js
// lambda/socials-sweep.mjs
export const handler = async () => {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '')
  const apiKey = process.env.SOCIALS_INTERNAL_API_KEY

  if (!publicUrl || !apiKey) {
    throw new Error('PUBLIC_URL and SOCIALS_INTERNAL_API_KEY are required')
  }

  const response = await fetch(`${publicUrl}/api/socials/internal/jobs/sweep`, {
    method: 'POST',
    headers: { 'x-socials-api-key': apiKey },
  })

  if (!response.ok) {
    throw new Error(`Socials sweep failed: ${response.status} ${await response.text()}`)
  }

  return { statusCode: 200 }
}
```

Assuming your existing Terraform creates the Lambda as `aws_lambda_function.socials_sweep`, only the schedule wiring is plugin-specific:

```hcl
resource "aws_cloudwatch_event_rule" "socials_sweep" {
  schedule_expression = "rate(5 minutes)"
}

resource "aws_lambda_permission" "socials_sweep" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.socials_sweep.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.socials_sweep.arn
}

resource "aws_cloudwatch_event_target" "socials_sweep" {
  arn  = aws_lambda_function.socials_sweep.arn
  rule = aws_cloudwatch_event_rule.socials_sweep.name
}
```

If the function is declared in another module, substitute that module's Lambda name and ARN outputs.

The equivalent as a plain crontab entry on any box that can reach your site:

```
*/5 * * * * curl -fsS -X POST "$PUBLIC_URL/api/socials/internal/jobs/sweep" -H "x-socials-api-key: $SOCIALS_INTERNAL_API_KEY"
```

The sweep is idempotent, so an overlapping fire cannot double-publish. Publish latency is roughly the schedule interval, so 5 minutes is a good default.

### Mode B: Native Payload Jobs

Setting `scheduling.autoRun` crons attaches Payload task-level `schedule` entries to the plugin's sweep/insights/connection tasks. **You still run the worker** — the plugin never writes to your `jobs.autoRun`.

```ts
// Plugin options:
scheduling: {
  internalApiKey: process.env.SOCIALS_INTERNAL_API_KEY!,
  queue: 'operator-socials',
  autoRun: {
    cron: '*/5 * * * *',                 // the sweep (optional if you drive it via the endpoints)
    insightsRefreshCron: '0 * * * *',    // optional: pull engagement hourly
    connectionRefreshCron: '0 3 * * *',  // optional: refresh tokens nightly
  },
},
```

Then configure the host-owned Payload Jobs worker on the same queue:

```ts
export default buildConfig({
  jobs: {
    autoRun: [{ cron: '* * * * *', queue: 'operator-socials' }],
  },
  plugins: [SocialsPlugin],
  // ...
})
```

The host `jobs.autoRun` entry runs the worker; the plugin's task-level schedules enqueue the periodic sweep/insights/connection tasks. Alternatively, call `payload.jobs.handleSchedules()` and `payload.jobs.run()` from your own trigger. Without a worker that handles schedules and drains the selected queue, the configured task crons do nothing.

### Mode C: Worker loop

Call the exported functions from your own long-running process. The worker must construct the same normalized options used by the plugin:

```ts
import {
  normalizePluginOptions,
  runQueuedSocialsJobs,
  sweepDueSocialPosts,
} from 'payload-plugin-socials'
import { socialsOptions } from './socials'

const normalizedOptions = normalizePluginOptions(socialsOptions)

setInterval(
  async () => {
    await sweepDueSocialPosts(payload, normalizedOptions)
    await runQueuedSocialsJobs(payload, normalizedOptions)
  },
  5 * 60 * 1000,
)
```

Scheduling from the composer is safe regardless of mode: a past or near-past time is rejected instead of published immediately, and queued posts show their time and can be cancelled from the history list.

## Step 8: Templates (optional, recommended)

Create reusable copy templates in the **Social Templates** collection. Each is bound to a source kind, so an `entry` template only appears when composing from the collection mapped to `entry`. Build copy with the field picker (scoped to that collection's real fields, discovered from a sample record) and a live preview, or toggle raw mode to write `{{ }}` strings. Mark one "default for this collection" and it auto-applies.

Config `transformations` (in the plugin options) are the code-level default; templates layer on top. Precedence, most specific first: a chosen template, then a default template for the kind, then `transformations`, then the built-in copy builders.

```ts
// In the plugin config: operator-set defaults per source kind.
transformations: {
  entry: {
    pinterestTitle: '{{ title }} | {{ metadata.audience | default:Featured }}',
    instagramCaption: '{{ title }}\n\n{{ description | truncate:2000 }}',
  },
  campaign: {
    instagramCaption: '{{ title }}\n\n{{ description }}\n\n{{ metadata.itemCount }} highlights',
  },
  '*': { facebookMessage: '{{ title }}\n\n{{ description | truncate:400 }}' },
},
```

## Deployment

- **Import map in the build.** Run `generate:importmap` in the same build that ships the admin, or the composer and template builder render blank in production.

- **Public asset URLs.** The platforms fetch images and rendition URLs from outside your network. Ensure they are public (CDN or public bucket), not localhost or short-lived signed URLs.

- **Secrets.** Provide `SOCIALS_ENCRYPTION_KEY`, the platform credentials, and `SOCIALS_INTERNAL_API_KEY` through your secret manager. The encryption key must be identical across every instance of an environment; changing it orphans stored tokens.

- **Migrations.** The generated migration ships with your build and runs against the production database as part of your normal deploy.

## Production checklist

- [ ] `SOCIALS_ENCRYPTION_KEY` (32 bytes) set in every environment, stable per environment.
- [ ] Meta app/use case is **Live**, not Development; required permission access and review are complete.
- [ ] Meta token validated in the Access Token Debugger; assigned Pages, permissions, and actual expiry recorded in operations documentation.
- [ ] Facebook and Instagram canaries are visible from a logged-out or non-role account, not only from an app administrator/tester.
- [ ] Pinterest redirect URI registered; a publisher completed the one-time Connect on production.
- [ ] `assets.autoConvert` on with a dedicated, format-free rendition collection (if your media is not JPEG).
- [ ] Rendition and media URLs publicly fetchable from outside your network.
- [ ] `generate:importmap` ran in the build that ships the admin.
- [ ] Migration generated, inspected, applied.
- [ ] A scheduling trigger is firing (schedule a post 5 minutes out and watch it publish).
- [ ] Smoke test per platform with real content, then delete.
- [ ] Alerting covers failed and `unknown` publication rows; operators know how to verify and resolve ambiguous provider outcomes.

## Troubleshooting

- **The Socials tab or template builder is blank.** Stale import map. Run `pnpm payload generate:importmap` and rebuild.
- **A publish fails with a format error.** The image is a format the platform rejects (commonly WebP on Instagram). Enable `assets.autoConvert` with a rendition collection (Step 4), or serve JPEG.
- **A publish fails fetching the image.** The URL is not publicly reachable. Check for localhost, expiring signed URLs, or IP allowlists.
- **Meta returns a post/media ID, but ordinary users cannot see it.** The app is usually still in Development mode or lacks the required Live permission access. Check App Mode, App Review/access levels, token scopes, and granular asset assignments, then repeat the canary from a non-role account.
- **An extensionless CDN image fails preflight.** Extensions are not required; the plugin checks file-signature bytes. A failure means the signature was unreadable or unrecognized and is intentionally fail-closed while preflight is enabled.
- **A private media origin is rejected.** Prefer a public CDN. If the origin is host-controlled and intentionally private, add its exact DNS hostname to `assets.trustedRemoteHosts`; this explicitly bypasses private-address rejection for that host.
- **A post is `unknown`.** The provider may have accepted the write even though the response was lost, or the provider returned an ID but final audit persistence failed. The latter path captures that ID whenever the database accepts the safety-fence update. Verify the destination first; then use `POST /api/socials/posts/{id}/resolve` with `outcome: 'published'` plus the provider ID, or `outcome: 'not-published'`. Do not retry before reconciling.
- **Pinterest connects but publishing 403s.** The account may lack a required scope, or the app may be in Trial Access. See [docs/pinterest.md](./pinterest.md).
- **Scheduled posts never publish.** No sweep trigger is firing. Confirm your scheduler is POSTing `/api/socials/internal/jobs/sweep` (Step 7).
- **An aggregate composer shows no related images.** The `where` clause in the aggregate resolver does not match your relationship field. Adjust it to your schema and ensure the upload relationships are populated at the resolver's selected depth.
