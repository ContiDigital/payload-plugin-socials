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
  system user with the `CREATE_CONTENT` task, then generate a token with the
  intended expiry policy. A token without a scheduled expiry can still be
  invalidated by revocation, role or asset changes, app changes, or provider
  enforcement; monitor connection health.
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

## 4. Publish the app (Development mode hides your posts)

This is the single most confusing failure mode in the entire Meta setup, so it
gets its own step. While your Meta app is in **Development mode**:

- The plugin's publishes **succeed**. Graph returns a post ID, the post reports
  `is_published: true` with privacy `EVERYONE`, and attached photos land on the
  Page.
- But the post is visible **only to accounts with a role on the app or Page**.
  Every other viewer — including the post's own permalink opened from another
  account — gets a "this content isn't available" error.

Nothing is wrong with the post, the token, or the plugin; Meta gates public
visibility at the app level until the app is published. In the current App
Dashboard there is no Development/Live toggle for use-case-based business apps:
complete the testing requirements listed on each use case (Facebook page
management, Instagram) until they read **"Testing complete,"** then click
**Publish**. Existing development-mode posts may or may not become publicly
visible after publishing — verify from a non-role account, and republish if a
post stays restricted.

Do this before judging any visibility problem, and before a production launch.

## 5. Configure the plugin

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
resumable-session upload are outside the initial public source contract.

## Scheduling

A `scheduledPublishTime` (or a `scheduledAt` in the source-publish payload)
must be at least 10 minutes in the future, and at most 75 days out for feed
posts or 6 months for videos. The plugin validates these bounds and records the
provider-accepted post as `scheduled` with a pending platform status. A
reconciliation job confirms when Facebook reports it published and only then
sets `publishedAt`. Plugin-level `scheduledAt` remains queued until its Payload
job executes.

## Gotchas

- **Public URLs.** Meta fetches photo and video URLs server-side, so they must
  be publicly reachable.
- **A Page token only works on its own Page.** The plugin derives the right
  token per Page, so do not reuse one across Pages.
- **`appsecret_proof`.** The shared Meta client computes it from the exact
  token used for each request, including Page-scoped tokens.
