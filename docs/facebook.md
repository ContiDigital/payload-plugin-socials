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

`pages_manage_posts` requires **Advanced Access** when the app serves Pages
outside its own role-user/business test set. A public or multi-tenant app
therefore needs **App Review** and the Business Verification Meta requests for
that use case. Access approval and Live mode are separate gates: approval does
not make a Development-mode test post public.

## 4. Development mode is not public publishing

> **Important:** A new Meta app starts in **Development mode**. In that mode,
> the Graph API can accept a Page publish and return a real post ID, but Meta
> classifies the resulting post as test data that only app-role users, such as
> administrators, developers, and testers, can see. A successful API response
> is not proof of public visibility.

Meta documents this behavior in
[App Modes](https://developers.facebook.com/documentation/development/build-and-test/app-modes):
Development-mode data, including test posts, is limited to role users and can
become visible to non-role users after the app switches to **Live**.

Before switching to Live, delete any test Page posts you do not want exposed.
Then:

1. Complete the current App Review, Business Verification, and permission
   access requirements shown for the Page-management use case.
2. Switch the app/use case from **Development** to **Live** in the Meta App
   Dashboard.
3. Validate the runtime token again, including `pages_manage_posts`, its
   granular Page assignment, and the system user's `CREATE_CONTENT` task.
4. Publish a fresh canary and open its canonical permalink while logged out or
   from an account with no role on the app, Meta Business, or Page.
5. Treat a role-only canary as an app-mode, permission-access, or asset
   assignment problem before diagnosing the plugin transport.

For a single-business backend, the assets may remain limited to the business
that owns the app. A multi-tenant/public integration also needs the applicable
Advanced Access approval before non-role businesses can authorize and publish.

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

## Insights metrics

Meta retired the legacy Page/Post impressions, reach, and 3-second video-view
metric families for every Graph API version on June 15, 2026. The plugin now
requests the documented post-level replacements and surviving engagement
metrics:

- `post_media_view`
- `post_total_media_view_unique`
- `post_clicks`
- `post_reactions_by_type_total`

The adapter attempts the set in one request. If Meta returns Graph error code
100 for an unavailable or account-incompatible metric, it retries each metric
individually and returns the valid subset. The insights snapshot records any
rejected names in `unavailableMetrics`; unavailable metrics are absent from the
backward-compatible `metrics` record.

## Gotchas

- **Public URLs.** Meta fetches photo and video URLs server-side, so they must
  be publicly reachable.
- **A Page token only works on its own Page.** The plugin derives the right
  token per Page, so do not reuse one across Pages.
- **`appsecret_proof`.** The shared Meta client computes it from the exact
  token used for each request, including Page-scoped tokens.
