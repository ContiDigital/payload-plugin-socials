# Facebook Pages setup

Facebook Pages publishing runs on the Meta Graph API and shares a Meta app with
[Instagram Business](./instagram.md). Create one Meta app and reuse it for both.

## Prerequisites

- A Facebook **Page** you administer.
- A Meta app and a Meta Business (Business Manager).

## 1. Create the Meta app

Same as the Instagram guide: create an app at
[developers.facebook.com](https://developers.facebook.com/) and copy the
**App ID** and **App secret** into `META_APP_ID` and `META_APP_SECRET`.

## 2. Page access tokens

Publishing to a Page uses a **Page-scoped access token**, not the user token.
Calling the feed endpoint with a user token would post to the user's timeline
instead of the Page.

The plugin derives the Page token for you. You just need a credential that can
reach the Page:

- **System user token** (recommended for a backend): assign the Page to the
  system user with the `CREATE_CONTENT` task, then generate a never-expiring
  token. A Page token derived from this is effectively non-expiring while the
  system user keeps the role.
- **OAuth user login**: the user authorizes, and the plugin reads the Page token
  from `/me/accounts`. Add this redirect URI:

  ```
  https://YOUR_HOST/api/socials/facebook/oauth/callback
  ```

## 3. Permissions

```
pages_show_list, pages_read_engagement, pages_manage_posts
```

`pages_manage_posts` is **Advanced Access**, so a public app needs **App
Review** plus **Business Verification** to publish to Pages it does not own
through testers.

## 4. Configure the plugin

```ts
platforms: {
  facebook: {
    enabled: true,
    apiVersion: 'v25.0',
    appId: process.env.META_APP_ID!,
    appSecret: process.env.META_APP_SECRET!,
    systemUserAccessToken: process.env.META_SYSTEM_USER_TOKEN,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/facebook/oauth/callback`,
  },
}
```

## Supported formats

- `LINK`: text, or text plus a link that auto-renders a preview card.
- `PHOTO`: a single photo from a public URL.
- `PHOTO_MULTI`: 2 to 10 photos, uploaded unpublished and then attached to one
  feed post.
- `VIDEO`: a public URL the plugin passes as `file_url` for Meta to fetch.

The adapter deliberately uses Meta's `file_url` ingestion because social source
media is represented by a public URL. Meta fetches the bytes directly, avoiding
an unnecessary large-file proxy through the Payload process. Local-file and
resumable-session upload are outside the v1 source contract.

## Scheduling

A `scheduledPublishTime` (or a `scheduledAt` in the source-publish payload)
must be at least 10 minutes in the future, and at most 75 days out for feed
posts or 6 months for videos. The plugin validates these bounds and records the
platform-accepted post as `published` with a pending platform status and the
future publish timestamp. Plugin-level `scheduledAt` remains queued until its
Payload job executes.

## Gotchas

- **Public URLs.** Meta fetches photo and video URLs server-side, so they must
  be publicly reachable.
- **A Page token only works on its own Page.** The plugin derives the right
  token per Page, so do not reuse one across Pages.
- **`appsecret_proof`.** The shared Meta client computes it from the exact
  token used for each request, including Page-scoped tokens.
