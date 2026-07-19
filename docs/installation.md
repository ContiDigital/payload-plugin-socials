# Installation and host integration guide

This is the end-to-end guide for wiring `payload-plugin-socials` into a Payload CMS 3 project. It covers installation, credentials, the source resolver registry, the image format pipeline, scheduling, and the checklist for replacing an existing hand-rolled social integration. Platform-specific credential setup lives in the per-platform guides ([Pinterest](./pinterest.md), [Facebook](./facebook.md), [Instagram](./instagram.md), [Google Business Profile](./google-business-profile.md)).

Everything in this guide was validated against a production integration (a Payload 3.8x commerce app on Postgres, S3/CloudFront media, ECS deploys). The warning boxes mark the traps that integration actually hit.

## 1. Install the package

```bash
pnpm add payload-plugin-socials
```

While the repository is private, a pinned git dependency works too:

```json
"payload-plugin-socials": "github:YourOrg/payload-plugin-socials#<commit-sha>"
```

> **CI/Docker warning.** A private git dependency needs GitHub credentials wherever `pnpm install` runs. If your image build installs dependencies (most Dockerfiles do), pass a token as a build secret and rewrite the remote before install:
>
> ```dockerfile
> RUN --mount=type=secret,id=gh_token \
>     git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/" \
>  && pnpm i --frozen-lockfile
> ```
>
> Runtime-only secrets do not help here; the token must reach the build stage.

## 2. Minimal wiring

```ts
import { payloadPluginSocials } from 'payload-plugin-socials'

plugins: [
  payloadPluginSocials({
    encryptionKey: process.env.SOCIALS_ENCRYPTION_KEY!, // 32 bytes, hex or base64. openssl rand -hex 32
    authorize: async ({ req, scope }) => {
      const role = req.user?.role
      if (!role) return false
      return scope === 'admin'
        ? ['admin', 'owner'].includes(role)
        : ['admin', 'owner', 'sales', 'seo'].includes(role)
    },
    platforms: {/* section 4 */},
    sources: {/* section 5 */},
    admin: { mode: 'both', injectInto: [{ collection: 'products', sourceKind: 'product' }] },
  }),
]
```

`authorize` receives `scope: 'admin' | 'publisher'`. Admin gates connection management and template authoring; publisher gates composing and publishing. Map both onto your own role model.

## 3. The three commands nobody remembers (all required)

After wiring the plugin, in your project:

```bash
pnpm payload generate:types       # plugin collections join your CollectionSlug union
pnpm payload generate:importmap   # REQUIRED: the admin components are invisible without it
pnpm payload migrate:create socials_plugin && pnpm payload migrate
```

> **Import map warning.** The plugin mounts custom admin components (the composer, the template field builder) through Payload's import map. If you skip `generate:importmap`, the Socials tab and the template builder render as empty space with no error anywhere. This is the number one "the plugin looks broken" report.

> **Migration policy.** The plugin never writes or runs migrations. It contributes schema (the `social-posts` and `social-templates` collections and the `socials-connections` global); you generate and apply the migration. Inspect the generated file before applying, as you would for any schema change.

## 4. Credentials: pick the right auth model per platform

### Meta (Facebook + Instagram): use a System User token, not OAuth

For a single-tenant install publishing to your own Page and IG account, a Business Manager **System User token** is strictly better than OAuth: it never expires, needs no Meta App Review, no redirect URIs, and the plugin treats it as a config-managed connection that is simply always connected.

```ts
facebook: {
  appId: process.env.META_APP_ID!,
  appSecret: process.env.META_APP_SECRET!,
  systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN!,
},
instagram: { /* same three values */ },
```

Required token scopes: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`. The IG account must be a Business account linked to the Facebook Page. Reserve the OAuth fields (`redirectUri` instead of `systemUserAccessToken`) for multi-tenant products where each customer connects their own Page.

### Pinterest: OAuth only, one click, one callback URL

Pinterest has no service-account concept. Configure the app credentials, register the callback in the Pinterest developer console, and a staff member clicks Connect once in `/admin/socials`; the encrypted refresh token then self-renews.

```ts
pinterest: {
  clientId: process.env.PINTEREST_APP_ID!,
  clientSecret: process.env.PINTEREST_APP_SECRET!,
  redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
},
```

The `redirectUri` must be registered verbatim in the Pinterest app settings.

### Google Business Profile: start the access request first

GBP is fully implemented but gated by Google's API access approval (days to weeks). Submit the Basic API Access application early, and add the `gbp` platform config (client id, secret, `.../api/socials/gbp/oauth/callback`) only once approved. See [the GBP guide](./google-business-profile.md).

### Webhooks

None required. Publishing, scheduling, and insights are outbound or polled. The plugin's webhook receivers are optional extras.

## 5. Source resolvers: how your content reaches the composer

For every kind of document you want to publish from, register a resolver that maps the document to a `SocialSourceContext`. The composer, templates, and default copy builders all operate on this shape; a resolver is the only glue you write.

```ts
sources: {
  product: async ({ payload, id }) => {
    const p = await payload.findByID({ collection: 'products', id, depth: 1 })
    const img = (m, role) => (m && typeof m === 'object' && m.url
      ? [{ url: m.url, role, width: m.width, height: m.height, format: m.mimeType?.split('/')[1] }]
      : [])
    return {
      sourceId: String(p.id),
      sourceKind: 'product',
      baseTitle: p.title,
      baseDescription: p.description ?? '',
      link: `${process.env.PUBLIC_URL}/products/${p.slug}`,
      images: [...img(p.mainImage, 'main'), ...(p.detailImages ?? []).flatMap((m) => img(m, 'detail'))],
      metadata: { material: p.material, price: p.price },
    }
  },
},
```

Rules of thumb learned in production:

- **Set `format`** on each image (the mime subtype). It powers pre-publish format validation so operators see "Instagram does not accept webp" in the composer instead of a failed publish.
- **Populate guards.** Relation fields are numeric ids until `depth` populates them; skip anything without a `url`.
- **Watermarks and overlays.** If your media pipeline bakes watermarks, point resolvers at your clean-asset fields.
- **`metadata` is the template surface.** Every key you place there is available to templates as `{{ metadata.key }}` and appears in the template builder's token picker once a sample record is previewed. If a template author asks for a field, expose it here.
- One collection per `sourceKind`, and each `admin.injectInto` entry maps a collection to its kind. Register as many kinds as you like; the composer works identically on all of them, and the standalone composer at `/admin/socials` works with none.

## 6. The image format pipeline (read this if your media is not JPEG)

Instagram accepts JPEG only. Facebook and GBP reject WebP and AVIF. If your upload collection converts to WebP (a common Payload `formatOptions` setup), every Instagram publish will fail out of the box, by design, with an actionable error.

Enable automatic conversion:

```ts
assets: {
  autoConvert: true,
  renditionCollection: 'social-renditions',
},
```

The plugin detects the true format by magic bytes, transcodes to JPEG with sharp, uploads the rendition to `renditionCollection` under a deterministic name (re-publishes reuse it), and sends the platform the rendition URL. Idempotency keys always derive from the original URL, so conversion never fragments post identity.

> **The rendition collection must not re-encode.** Do NOT point `renditionCollection` at an upload collection with `formatOptions` (for example `format: 'webp'`): Payload would convert the plugin's JPEG right back and the pipeline silently produces the format you were escaping. Create a dedicated collection:
>
> ```ts
> export const SocialRenditions: CollectionConfig = {
>   slug: 'social-renditions',
>   access: { read: () => true, create: () => false, update: () => false, delete: () => false },
>   admin: { hidden: true },
>   upload: { disableLocalStorage: true, mimeTypes: ['image/*'] }, // no formatOptions, no imageSizes
>   fields: [{ name: 'alt', type: 'text' }],
> }
> ```
>
> Register it with your storage adapter (S3 and similar) exactly like your media collection.

> **Public URLs are non-negotiable.** Meta, Pinterest, and Google fetch images server-side. Rendition and media URLs must be publicly reachable (CDN or public bucket): no localhost, no signed URLs shorter than 24 hours, no IP allowlists.

## 7. Scheduling: the plugin defines tasks, you fire the trigger

Scheduled posts sit in `social-posts` as `queued` rows until a sweep publishes them. Pick one trigger:

- **Long-running server, simplest:** `scheduling: { autoRun: { cron: '*/5 * * * *' } }` and Payload's own job runner sweeps.
- **Your infrastructure's cron (or if your project disables Payload autoRun globally):** set `scheduling.internalApiKey` and have any scheduler (EventBridge, Vercel cron, GitHub Actions) POST `/api/socials/internal/jobs/sweep` every few minutes with the `X-Socials-API-Key` header.
- **Worker process:** import `sweepDueSocialPosts` / `runQueuedSocialsJobs` and call them in your loop.

> Projects that hard-disable Payload's `jobs.autoRun` (for example "all jobs run through SQS" architectures) must use the second or third option; the plugin's autoRun entry is subject to your global `shouldAutoRun`.

The scheduling UX is safe by default: past or near-past times are rejected with a 400 (never silently published), queued rows show their scheduled time in the composer history, and they can be cancelled there.

## 8. Replacing an existing hand-rolled integration

Validated pattern from migrating a production Pinterest implementation:

1. **Add the plugin first, remove second.** Land the plugin fully working (install, resolvers, composer on your collections) before deleting anything. The two stacks coexist without conflict; the plugin's OAuth tokens live in its own encrypted global.
2. **Archive legacy data in place.** Do not unregister the old collection (that generates a `DROP TABLE` migration). Set `admin.hidden: true` and lock writes (`create/update/delete: () => false`). The rows remain queryable history; nothing destructive ships.
3. **Retire the old publish surface** (endpoints, tasks, admin components) once the plugin path is verified. Keep anything unrelated to organic publishing (for example a Pinterest catalog TSV feed) on its original code path; the plugin deliberately does not own catalog feeds.
4. **Check the migration diff.** After all wiring, `migrate:create` must only ADD plugin tables. If a destructive statement appears, a collection was unregistered by mistake.

## 9. Production deployment checklist

- [ ] `SOCIALS_ENCRYPTION_KEY` (32 bytes) present in every runtime environment; changing it orphans stored tokens.
- [ ] Meta system-user token generated with the six scopes, never expires (verify with the Graph token debugger, `expires_at: 0`).
- [ ] Pinterest callback URL registered; staff performed the one-time Connect on production.
- [ ] `assets.autoConvert` + dedicated rendition collection if your media is not guaranteed JPEG.
- [ ] Rendition/media URLs publicly fetchable from outside your network.
- [ ] `generate:importmap` ran in the build that ships the admin (stale import maps render empty components).
- [ ] Migration generated, inspected, applied.
- [ ] A scheduling trigger is firing (schedule a post 5 minutes out and watch it publish).
- [ ] Smoke test per platform with real content, then delete: publish, verify live, re-publish (idempotency returns the same post), delete from history. Note: Instagram posts cannot be deleted through Meta's API; the composer offers "Mark deleted (removed in app)" to reconcile after manual deletion.
