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

## Managing the listing

Besides LocalPosts, the plugin reads and edits the listing itself through the
Business Information API. Reads need the `publisher` scope; every write needs
`admin`. Paths are relative to `/api/socials`, and `{locationId}` is the numeric
id (the last segment of `locations[].resourceName`).

| Method | Path                                      | Effect                                           |
| ------ | ----------------------------------------- | ------------------------------------------------ |
| GET    | `/gbp/locations?include=all`              | Every location on every account                  |
| GET    | `/gbp/locations/{locationId}`             | One listing in full                              |
| PATCH  | `/gbp/locations/{locationId}`             | Edit address, hours, description, phone, website |
| POST   | `/gbp/locations/{locationId}/open-status` | Open, close temporarily or close permanently     |
| DELETE | `/gbp/locations/{locationId}`             | Remove a listing Google marks deletable          |

### Reading

`GET /gbp/locations/{locationId}` returns `{ location }` with `title`,
`storeCode`, `categories`, `websiteUri`, `phoneNumbers`, `storefrontAddress`,
`latlng`, `regularHours`, `specialHours`, `openInfo` (`status`, `canReopen`,
`openingDate`), `profile.description`, `serviceArea`, `labels` and `metadata`
(`hasVoiceOfMerchant`, `hasPendingEdits`, `canDelete`, `duplicateLocation`,
`mapsUri`, `placeId` and Google's other flags). Tokens are never returned.

### Editing the profile

```http
PATCH /api/socials/gbp/locations/{locationId}
{
  "validateOnly": true,
  "patch": {
    "storefrontAddress": {
      "addressLines": ["100 Main Street"],
      "locality": "Springfield",
      "administrativeArea": "IL",
      "postalCode": "62701",
      "regionCode": "US"
    },
    "regularHours": {
      "periods": [
        { "openDay": "MONDAY", "openTime": { "hours": 10 }, "closeDay": "MONDAY", "closeTime": { "hours": 18 } }
      ]
    },
    "specialHours": {
      "specialHourPeriods": [{ "startDate": { "year": 2026, "month": 12, "day": 25 }, "closed": true }]
    },
    "profile": { "description": "At most 750 characters." },
    "phoneNumbers": { "primaryPhone": "+1 555 010 0100" },
    "websiteUri": "https://example.com/"
  }
}
```

Name only the fields you mean to change. The `updateMask` is derived from the
patch keys (`storefrontAddress`, `regularHours`, `specialHours`,
`profile.description`, `phoneNumbers.primaryPhone`, `websiteUri`), so a patch
never touches anything it does not name; any other key is a `400`. Regular and
special hours replace the whole list, so send the full set. An empty
`specialHourPeriods` list clears special hours. Times run from 00:00 to 24:00,
and 24:00 is accepted only as a closing time.

With `validateOnly: true` Google checks the exact change and saves nothing; the
answer is `{ updateMask, validateOnly: true }`. Without it the answer also
carries the listing as Google returned it. When Google rejects a change the
response is a `400` whose body carries `error` and `fieldViolations`
(`[{ field, message, reason }]`) taken from Google's error details.

Google reviews some edits, address changes above all, and may ask the account
owner to verify the business again. Read `metadata.hasPendingEdits` afterwards;
a listing without voice of merchant cannot be edited this way.

### Opening and closing

```http
POST /api/socials/gbp/locations/{locationId}/open-status
{ "status": "CLOSED_PERMANENTLY", "expectedTitle": "Old Street Listing", "validateOnly": false }
```

`status` is `OPEN`, `CLOSED_TEMPORARILY` or `CLOSED_PERMANENTLY` and only
`openInfo.status` is sent. With `expectedTitle`, the listing is read first and a
different title refuses with `409`, so an agent cannot close the wrong listing.
A permanent closure shows on Maps and Search at once; reopening may need
verification again.

### Removing a stale listing

```http
DELETE /api/socials/gbp/locations/{locationId}?expectedTitle=Old%20Street%20Listing
```

The plugin reads the listing first and sends the deletion only when Google's
own flags allow it:

- `metadata.canDelete` must be `true`; otherwise `409` and the listing must be
  closed instead, or removed on the Business Profile site.
- A verified listing (`hasVoiceOfMerchant`) is deleted only when Google names it
  a duplicate in `metadata.duplicateLocation`; otherwise `409` "A verified
  listing is closed, not deleted."

Deletion cannot be undone. The answer is `{ deleted: true, location }` with the
listing as it was read just before.

### From host code

The same operations are exported for hosts that run provider work in their own
job runner: `getLocation`, `updateLocation(payload, options, location, patch,
{ validateOnly })`, `setOpenStatus`, `deleteLocation`, `listAllLocations`,
`buildLocationPatch` (the pure mask and validation step) and
`locationDeletionRefusal`.

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
