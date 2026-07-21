# Agent and headless integration

The plugin is a deterministic action API: callers provide finished copy and destinations; the plugin validates, publishes, audits, and reconciles. Copy generation and approval policy belong to the caller.

Public posting is consequential. A production agent should use a dedicated least-privilege Payload identity, require human approval when appropriate, assign a stable `publicationKey`, inspect every per-channel result, and never retry a publication whose provider outcome is unknown.

## Authentication

Enable Payload API keys on the host's auth collection:

```ts
import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  auth: { useAPIKey: true },
  fields: [
    {
      name: 'role',
      type: 'select',
      options: ['admin', 'owner', 'marketing', 'service'],
      required: true,
    },
  ],
}
```

Create a dedicated service user and grant it `publisher`, not `admin`:

```ts
authorize: async ({ req, scope }) => {
  const role = req.user?.role
  if (!role) return false
  if (scope === 'admin') return ['admin', 'owner'].includes(role)
  return ['admin', 'owner', 'marketing', 'service'].includes(role)
}
```

Send its credential using Payload's API-key header format:

```http
Authorization: users API-Key <service-user-api-key>
```

Store the key in a server-side secret store. The separate `X-Socials-API-Key` credential is only for `/internal/*` scheduler routes and must not be reused as a user credential.

If the host has more than one auth collection, configure `authCollection` explicitly so publication attribution targets the correct collection.

## Destination discovery

Resolve and cache destinations before asking a model or user to choose one:

| Platform  | Endpoint                              | Publish identifier                                                |
| --------- | ------------------------------------- | ----------------------------------------------------------------- |
| Pinterest | `GET /api/socials/pinterest/boards`   | `boardId`                                                         |
| Facebook  | `GET /api/socials/facebook/pages`     | `pageId`                                                          |
| Instagram | `GET /api/socials/instagram/accounts` | `igUserId`                                                        |
| GBP       | `GET /api/socials/gbp/locations`      | full `locationResourceName`, such as `accounts/123/locations/456` |

Do not infer identifiers from labels. Preserve the exact identifiers returned by discovery.

## Standalone multi-channel publication

`POST /api/socials/compose/publish` accepts free-form content and one or more platform targets. Each target succeeds or fails independently.

```json
{
  "content": {
    "title": "Hand-carved Carrara marble mantel",
    "body": "New in the gallery this week.",
    "link": "https://example.com/products/carrara",
    "images": [
      {
        "format": "jpeg",
        "role": "main",
        "url": "https://cdn.example.com/carrara.jpg"
      }
    ],
    "metadata": { "material": "marble" }
  },
  "targets": [
    {
      "platform": "pinterest",
      "input": {
        "boardId": "5497558",
        "imageUrl": "https://cdn.example.com/carrara.jpg",
        "publicationKey": "campaign-2026-07-carrara-pinterest"
      }
    },
    {
      "platform": "facebook",
      "input": {
        "format": "LINK",
        "pageId": "1000000",
        "publicationKey": "campaign-2026-07-carrara-facebook"
      }
    },
    {
      "platform": "instagram",
      "input": {
        "igUserId": "17841400000000000",
        "imageUrl": "https://cdn.example.com/carrara-square.jpg",
        "mediaType": "IMAGE",
        "publicationKey": "campaign-2026-07-carrara-instagram"
      }
    },
    {
      "platform": "gbp",
      "input": {
        "locationResourceName": "accounts/123/locations/456",
        "publicationKey": "campaign-2026-07-carrara-gbp",
        "topicType": "STANDARD"
      }
    }
  ]
}
```

The endpoint returns `200` if at least one target succeeds and `502` if all targets fail. Always inspect `results`; HTTP 200 does not mean every target succeeded.

```json
{
  "anyPublished": true,
  "results": [
    {
      "ok": true,
      "platform": "pinterest",
      "publishedRef": {
        "externalId": "113000000000000000",
        "externalUrl": "https://www.pinterest.com/pin/113000000000000000/",
        "platform": "pinterest"
      }
    },
    {
      "error": "Facebook page is not connected",
      "ok": false,
      "platform": "facebook"
    }
  ],
  "source": {
    "id": "<content-hash>",
    "kind": "standalone"
  }
}
```

Error strings are sanitized for callers. Keep provider diagnostics in server logs and the audit row rather than exposing raw upstream responses to users.

## Publishing an existing source record

For a registered source resolver, use:

```http
GET  /api/socials/{platform}/{kind}/{id}/preview
POST /api/socials/{platform}/{kind}/{id}/validate
POST /api/socials/{platform}/{kind}/{id}/publish
GET  /api/socials/{platform}/{kind}/{id}/history
```

The preview route resolves default copy and media without accepting a request body. Send the proposed platform input to `validate`, then send the same input to `publish`. Add `scheduledAt` to the publish body for plugin-level scheduling.

## Idempotency and retry rules

For source-record publication, the default identity includes the platform, source, destination, format where relevant, and primary asset. For standalone publication, the source ID is a content hash of title, body, and primary image. Therefore an edited standalone post can receive a new default identity.

Agents should set a unique, durable `publicationKey` per logical campaign and platform. Reusing that key intentionally addresses the same audit row even if copy or media changes. Keep it at 200 characters or fewer and persist it before the first request. `idempotencyKeyOverride` is only for adopting a known legacy SHA-256 hash.

The plugin does not replay an unsafe provider write when its typed transport result cannot rule out provider acceptance. It also suppresses replay when the provider returned a publication ID but the subsequent local audit write failed; in that case the provider ID is captured whenever the database can accept the safety-fence update. The row becomes `unknown`, or remains non-reclaimable as `publishing` if that fence write also fails. The caller must:

1. Inspect the destination in the provider UI or API.
2. If the post exists, resolve with its provider ID:

   ```json
   {
     "outcome": "published",
     "externalId": "provider-id",
     "externalUrl": "https://provider.example/post"
   }
   ```

3. If it definitely does not exist, resolve with `{ "outcome": "not-published" }`.

Send either body to `POST /api/socials/posts/{postId}/resolve` as a publisher. Only after a confirmed `not-published` outcome may the logical publication be retried.

## Delete and reconciliation

`DELETE /api/socials/posts/{postId}` deletes upstream where the provider supports it and soft-deletes the audit row. Pinterest, Facebook, and GBP support API deletion. Instagram does not expose deletion for published Business media through this API surface; remove it in Instagram first, then call the delete route with `?localOnly=true` to reconcile the ledger.

`localOnly=true` is also appropriate after an operator independently confirms a provider post is already absent. It must not be used merely to hide an unverified failure.

## Reference tool wrapper

This framework-neutral Python example keeps approval outside the plugin and treats per-channel failure as first-class. Adapt the `approve` callback to your human-in-the-loop system.

```python
from collections.abc import Callable
import os
import httpx

BASE_URL = f"{os.environ['PAYLOAD_URL'].rstrip('/')}/api/socials"
AUTH = {"Authorization": f"users API-Key {os.environ['SOCIALS_AGENT_API_KEY']}"}


def publish_social_post(
    *,
    approve: Callable[[dict], None],
    content: dict,
    targets: list[dict],
) -> dict:
    request = {"content": content, "targets": targets}
    approve(request)

    with httpx.Client(timeout=120) as client:
        response = client.post(
            f"{BASE_URL}/compose/publish",
            headers=AUTH,
            json=request,
        )
        result = response.json()
        if response.status_code not in (200, 502):
            response.raise_for_status()

    failures = [item for item in result["results"] if not item["ok"]]
    if failures:
        # Report each failure; do not automatically replay the whole request.
        result["requires_attention"] = failures
    return result
```

Use short network timeouts for discovery and validation, a deliberate publish timeout, structured audit logging without credentials, and an approval record containing the exact content, destinations, and `publicationKey` values.
