# Instagram Business setup

Instagram Business publishing runs on the Meta Graph API, so this setup shares a
Meta app with [Facebook Pages](./facebook.md). If you publish to both, create
one Meta app and reuse it.

## Prerequisites

- An Instagram **Business** or **Creator** account. Stories publishing through
  the API requires a Business account specifically. Creator accounts cannot
  publish Stories through the API.
- The Instagram account linked to a Facebook **Page**.
- A Meta app and a Meta Business (Business Manager).

## 1. Create the Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com/) and create
   an app.
2. Copy the **App ID** and **App secret** into `META_APP_ID` and
   `META_APP_SECRET`.

## 2. Pick a credential mode

The plugin supports two, in precedence order.

### System user access token (recommended for a backend)

Best for a single business publishing from a server. The token does not expire.

1. In Business Manager, open Settings, then Users, then System Users, and add an
   **employee** system user.
2. Assign the Page (and the linked Instagram account) to the system user as
   assets, with the `CREATE_CONTENT` task.
3. Connect your app to the business, then generate a token for the system user
   with expiration set to **Never** and the scopes below.
4. Store it as `META_SYSTEM_USER_TOKEN`.

A system-user connection shows up in the Connections tab as connected with a
"Managed by server configuration" badge. It has no Connect or Disconnect button,
because the credential lives in your server environment. You connect or
disconnect it by changing that environment and redeploying, not from the admin
UI. The `socials-connections` global that holds the encrypted token is hidden
from the admin nav on purpose. It is internal AES-256-GCM storage, and editing
the envelopes by hand corrupts the tokens.

### OAuth user login (for multi-tenant)

Each tenant authorizes their own Facebook account. The short-lived user token is
exchanged for a long-lived (60-day) token, which the plugin refreshes by
re-exchange before it expires.

Add this redirect URI to the app:

```
https://YOUR_HOST/api/socials/instagram/oauth/callback
```

## 3. Permissions

```
instagram_basic, instagram_content_publish, instagram_manage_insights,
pages_show_list, pages_read_engagement
```

`instagram_content_publish` and `instagram_basic` are **Advanced Access**
permissions, so a public app needs **App Review** plus **Business
Verification** before it can act on accounts outside your own testers. Plan a
few business days to a few weeks for review.

## 4. Configure the plugin

```ts
platforms: {
  instagram: {
    enabled: true,
    apiVersion: 'v25.0',
    appId: process.env.META_APP_ID!,
    appSecret: process.env.META_APP_SECRET!,
    // Either a system user token...
    systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN,
    // ...or the OAuth flow:
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/instagram/oauth/callback`,
  },
}
```

## Media specifications

- **Feed image**: JPEG only, aspect ratio 4:5 to 1.91:1, 320 to 1440px wide,
  8MB maximum, sRGB. The plugin's image pipeline preflights these.
- **Reels**: MP4 or MOV (H.264 or HEVC plus AAC), 3 seconds to 15 minutes,
  300MB maximum, 9:16 recommended. Set `shareToFeed: true` to put a Reel in both
  the Reels tab and the feed.
- **Carousel**: 2 to 10 children that share an aspect ratio. Reels cannot be
  carousel children.

## Image format safety

Instagram is the strictest platform for image formats: it accepts JPEG only.
If your upload collection stores images in WebP, PNG, or AVIF, those will be
rejected by Instagram's API with an opaque error. The plugin catches this at
publish time and either converts the image automatically or fails fast with a
clear message.

By default (`assets.preflight: true`), the plugin detects the image format
(from metadata or by reading the first 32 bytes of the URL) and checks it
against Instagram's JPEG-only allowlist. If the format is not allowed:

- With `assets.autoConvert: true` and a `renditionCollection`, the plugin
  transcodes to JPEG via sharp and uploads the result to your collection.
  Subsequent publishes of the same source URL reuse the existing rendition.
- Without `autoConvert`, the plugin throws a validation error that names the
  detected format and the two ways to fix it (configure a JPEG imageSize on
  your upload collection, or enable `autoConvert`).

The simplest setup for Instagram publishing is to add `formatOptions` to your
upload collection's `imageSizes` so that Payload itself generates a JPEG
derivative at upload time, and point your source resolver at that derivative URL.

## Deleting posts

Meta's Graph API does not expose a delete endpoint for published Instagram
Business media. Calling `DELETE /{ig-media-id}` always returns `OAuthException`
code 10, regardless of the token or permissions used. This is a permanent
platform limitation as of Meta Graph API v25.0.

The plugin removes Instagram API deletion as a capability:

- `DELETE {basePath}/posts/:postId` on an Instagram row returns **HTTP 422**
  with an actionable message rather than attempting the upstream call. The local
  row is left untouched.
- The Instagram adapter's `delete` method throws immediately with the same
  message so programmatic callers see a clear error rather than a cryptic Meta
  API failure.

### Reconcile flow: mark-deleted

When an operator removes a post directly from the Instagram app, the local
`social-posts` row stays in `published` status with a live `externalId`. The
idempotency short-circuit would then return a stale reference forever and block
republishing. Use the **mark-deleted** reconcile path to bring the ledger back
in sync:

```
DELETE {basePath}/posts/:postId?localOnly=true
```

This skips all upstream API calls for any platform, soft-deletes the local row
(sets `status: 'deleted'`, `meta.deletedAt`, `meta.deletedBy`, and
`meta.deletedLocalOnly: true`), and makes the row re-claimable for republish.

In the `SocialPublishPanelClient` history panel, published Instagram rows show
a **"Mark deleted (removed in app)"** button instead of the normal Delete. The
same two-step confirm pattern applies (click to arm, click to confirm), then the
row is soft-deleted locally and the list refreshes.

A row marked deleted this way republishes in place on the next publish, exactly
like any other `deleted` row.

## Gotchas

- **Public, US-ASCII URLs.** Meta fetches `image_url` and `video_url`
  server-side. The URL must be public (no localhost, no auth headers) and use
  only US-ASCII characters.
- **Containers expire after 24 hours.** The plugin polls the container status
  and surfaces an expired container as a clear error.
- **Publishing limit.** An account can publish at most 100 posts in a rolling
  24-hour window. The plugin surfaces upstream errors rather than guessing.
