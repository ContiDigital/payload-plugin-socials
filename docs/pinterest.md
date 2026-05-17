# Pinterest setup

This guide walks through creating a Pinterest app, granting the right scopes,
and connecting it to the plugin. For the publishing API itself, see the
[Publishing](../README.md#publishing) section of the README.

## Prerequisites

- A Pinterest **business** account (convert a personal account under Settings
  if needed; write scopes are rate-limited far below business on personal
  accounts).
- A public HTTPS URL for your Payload host, so Pinterest can redirect back to
  the OAuth callback.

## 1. Create the app

1. Go to the [Pinterest developer portal](https://developers.pinterest.com/)
   and create a new app.
2. Copy the **App ID** (client id) and **App secret** (client secret) into your
   environment as `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET`.

## 2. Set the redirect URI

Add this exact redirect URI to the app (it must match character for character):

```
https://YOUR_HOST/api/socials/pinterest/oauth/callback
```

If you changed `api.basePath` in the plugin options, swap `/socials` for your
base path.

## 3. Scopes

The plugin requests these by default. Grant them on the app:

```
user_accounts:read, pins:read, pins:write, boards:read, boards:write
```

Request the read counterpart of anything you write. Many write endpoints fail
without it.

## 4. Access tiers and review

Pinterest apps start in **Trial Access**, where pins are visible only to the
account that created them, with low quotas. To publish to a real audience you
need **Standard Access**, which requires an app review (a screen recording of
the OAuth flow and the publishing flow). Review typically takes a few business
days. There is also an invite-only **Standard Plus** tier.

You can build and test the entire integration end to end on Trial Access before
requesting Standard, because trial pins are real (just private to your account).

## 5. Tokens

The plugin uses **continuous refresh tokens** (`refresh_on=true`). The access
token lasts 30 days and the refresh token lasts 60 days and is refreshable
indefinitely, so as long as the connection is exercised at least every 60 days
it stays alive. The legacy non-renewable refresh token is deprecated and the
plugin does not use it. Each refresh persists the most recent refresh token,
which Pinterest may rotate.

## 6. Configure the plugin

```ts
platforms: {
  pinterest: {
    enabled: true,
    clientId: process.env.PINTEREST_CLIENT_ID!,
    clientSecret: process.env.PINTEREST_CLIENT_SECRET!,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
    environment: 'production', // or 'sandbox' to hit Pinterest's sandbox host
    allowedVideoHosts: ['cdn.example.com'],
  },
}
```

Then connect from `/admin/socials`.

## Gotchas

- **Public images only.** Pinterest fetches `image_url` server-side once.
  Pre-signed S3 URLs that expire, IP-restricted CDNs, and bot-blocked URLs fail.
  Use a public CDN URL.
- **Video source allowlist.** Video Pins use Pinterest's register and upload
  flow, so the plugin streams bytes from the source URL. Every source and
  redirect host must be HTTPS and explicitly listed in `allowedVideoHosts`.
  The source must provide `Content-Length` and an MP4, MOV, or M4V content type;
  the plugin rejects files above Pinterest's 2 GB limit before transfer.
- **Minimum width 600px.** The plugin's preflight flags images below this. Aim
  for 1000 by 1500 (a 2:3 ratio) for the best placement.
- **No Idea or Story pins.** They are not writable through the v5 API, so the
  plugin does not offer them.
- **No organic carousel claim.** Pinterest carousel creation is part of the ads
  API. Organic v5 creation currently exposes image and video Pins.
- **Validate `state` on the callback.** The plugin does this for you with a
  state cookie, so serve the admin and callback routes over HTTPS.
