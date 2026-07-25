# Google Business Profile setup

Google Business Profile (GBP) LocalPosts have the longest lead time of the four
platforms, because Google must approve your Cloud project and verify the OAuth
scope before you can post in production. Start this early.

## Prerequisites

- A **verified** Google Business Profile (verified for at least 60 days helps
  with API access approval).
- A Google Cloud project.
- A public website for the business.

## 1. Enable the APIs

In your Cloud project, enable these APIs (some are not searchable in the library
until your access request is approved, which is expected):

```
mybusiness.googleapis.com                       (LocalPosts, legacy v4)
mybusinessaccountmanagement.googleapis.com      (accounts)
mybusinessbusinessinformation.googleapis.com    (locations)
businessprofileperformance.googleapis.com        (metrics, optional)
```

## 2. Request API access

GBP APIs are not granted by default. A project with quota `0` has not yet been
granted access and must use Google's Basic API Access application rather than a
quota-increase request. See Google's current [basic setup](https://developers.google.com/my-business/content/basic-setup) and [quota documentation](https://developers.google.com/my-business/content/limits).

1. Confirm the APIs are enabled (even at 0 QPM).
2. Submit the **Application for Basic API Access** form, with your Cloud
   **project number** (the numeric one), the GBP owner or manager email, your
   application URL, and a short use-case description.
3. Track the application through Google's process. Review time and assigned
   quotas are provider-controlled and can change.

## 3. OAuth consent and scope verification

The single scope is:

```
https://www.googleapis.com/auth/business.manage
```

This is a **sensitive** scope. A production app that serves external users must
complete OAuth verification (a verified domain, branding, a video of the OAuth
flow and the scope in use, a privacy policy, and a justification). This usually
takes a few business days and sometimes longer.

## 4. Pick a credential mode

- **OAuth user login**: the tenant's GBP admin authorizes once. Refresh tokens
  do not expire from age but lapse after 6 months of inactivity. Add this
  redirect URI:

  ```
  https://YOUR_HOST/api/socials/gbp/oauth/callback
  ```

  An External OAuth app left in **Testing** issues refresh tokens that expire
  after 7 days because `business.manage` is not a basic identity scope. This is
  acceptable for staging, but production needs a published and verified app
  (or an applicable Internal/Workspace-trusted configuration).

- **Service account** (JWT bearer): add the service account email as a
  **Manager** on the GBP account, or use Workspace Domain-Wide Delegation to
  impersonate a Workspace user who manages the account. A plain service account
  cannot manage a personal GBP, and Gmail accounts cannot be impersonated
  through delegation.

## 5. Configure the plugin

```ts
platforms: {
  gbp: {
    enabled: true,
    clientId: process.env.GBP_CLIENT_ID,
    clientSecret: process.env.GBP_CLIENT_SECRET,
    redirectUri: `${process.env.PUBLIC_URL}/api/socials/gbp/oauth/callback`,
    // OR the service-account path:
    // serviceAccount: {
    //   clientEmail: 'svc@project.iam.gserviceaccount.com',
    //   privateKey: process.env.GBP_SA_PRIVATE_KEY!,
    //   impersonate: 'admin@your-workspace-domain.com', // only with delegation
    // },
  },
}
```

## Post topic types

The plugin supports all four LocalPost topic types, and validates the per-topic
required fields:

- `STANDARD`: a summary, an optional call to action, and optional media.
- `EVENT`: adds an event with a title and a start and end schedule.
- `OFFER`: adds an event and an offer block. An offer cannot include a call to
  action.
- `ALERT`: provider-conditional and currently limited by Google to the
  `COVID_19` subtype. Google may disable creation outside sanctioned periods;
  such requests can be rejected even when their shape is valid. Alerts cannot
  carry media.

## Gotchas

- **No sandbox.** You cannot create test listings. Test against a real verified
  business that you own.
- **`canOperateLocalPost`.** Suspended, duplicate, and pending-verification
  locations return false and cannot accept posts. The plugin filters these out
  of the postable-locations list.
- **Media must be publicly reachable.** Google fetches the image at create time,
  so a slow or auth-gated URL fails with a fetch error.
- **No rejection reason through the API.** A post can be accepted and then
  rejected by moderation, with the reason visible only in the GBP dashboard.
