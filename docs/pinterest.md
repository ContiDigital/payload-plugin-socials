# Pinterest setup

This guide walks through creating a Pinterest app, granting the right scopes,
and connecting it to the plugin. For publication behavior, see
[Publication identity and retries](../README.md#publication-identity-and-retries).

## Prerequisites

- A Pinterest **business** account and an app approved for the access tier your
  deployment needs.
- A public HTTPS URL for your Payload host, so Pinterest can redirect back to
  the OAuth callback.

## 1. Create the app

1. Go to the [Pinterest developer portal](https://developers.pinterest.com/)
   and create a new app.
2. Copy the **App ID** (client id) and **App secret** (client secret) into your
   environment as `PINTEREST_APP_ID` and `PINTEREST_APP_SECRET`.

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

Pinterest apps start in **Trial Access**, where API-created Pins and boards are
visible only to their creator and quotas are lower. Production publishing needs
**Standard Access**, which requires review and a recording of the OAuth and API
flow. Consult Pinterest's current [access-tier documentation](https://developers.pinterest.com/docs/key-concepts/access-tiers/) for review and quota details.

You can build and test the entire integration end to end on Trial Access before
requesting Standard, because trial pins are real (just private to your account).

## 5. Tokens

The plugin uses Pinterest's continuous refresh-token flow. At the time of this
release, Pinterest documents 30-day access tokens and 60-day continuously
refreshable refresh tokens. Each refresh persists the latest token in case the
provider rotates it. Re-check Pinterest's current [authentication documentation](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/) when configuring operations.

## 6. Configure the plugin

```ts
platforms: {
  pinterest: {
    enabled: true,
    clientId: process.env.PINTEREST_APP_ID!,
    clientSecret: process.env.PINTEREST_APP_SECRET!,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/pinterest/oauth/callback`,
    environment: 'production', // or 'sandbox' to hit Pinterest's sandbox host
    allowedVideoHosts: ['cdn.example.com'],
  },
}
```

Then connect from `/admin/socials`.

## Optional metadata used by the default copy

The Pinterest defaults work with only `baseTitle` and `baseDescription`. When a
resolver provides these optional commerce-style metadata keys, the built-in
builders add the corresponding detail:

| Metadata key     | Default-copy effect                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `categoryLabel`  | Leads the description and, when not already in the title, identifies the collection in alt text.      |
| `googleMaterial` | Adds “crafted from …” to description and alt text and contributes a hashtag.                          |
| `googleColor`    | Adds “in …” to description and alt text and contributes a hashtag unless the value describes “multi”. |
| `dimensions`     | Adds a dimensions sentence to the description and a “measuring …” phrase to alt text.                 |

`modelLabel` also augments the title and description, while
`hints.pinterestSegments` supplies explicit hashtag candidates. These names are
a convention, not a required source schema: omit them or replace the defaults
with transformations, `copyOverrides`, or templates.

## Gotchas

- **Public images only.** Pinterest fetches `image_url` server-side once.
  Pre-signed S3 URLs that expire, IP-restricted CDNs, and bot-blocked URLs fail.
  Use a public CDN URL.
- **Video source allowlist.** Video Pins use Pinterest's register and upload
  flow, so the plugin streams bytes from the source URL. Every source and
  redirect host must be HTTPS, explicitly listed in `allowedVideoHosts`, and
  resolve only to public IP space. Each connection is pinned to its validated
  address. The source must provide `Content-Length` and an MP4, MOV, or M4V
  content type; the plugin enforces the 2 GB limit against both the header and
  the streamed body and rejects a body whose actual length differs.
- **Minimum width 600px.** The plugin's preflight flags images below this. Aim
  for 1000 by 1500 (a 2:3 ratio) for the best placement.
- **No Idea or Story pins.** They are not writable through the v5 API, so the
  plugin does not offer them.
- **No organic carousel claim.** Pinterest carousel creation is part of the ads
  API. Organic v5 creation currently exposes image and video Pins.
- **Validate `state` on the callback.** The plugin does this for you with a
  state cookie, so serve the admin and callback routes over HTTPS.
