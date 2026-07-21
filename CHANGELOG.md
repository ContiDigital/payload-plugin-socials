# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-07-20

### Added

- Public Payload CMS 3 plugin factory with root, client, and RSC export maps.
- Production admin composer for source records plus a standalone multi-channel composer.
- Pinterest, Instagram Business, Facebook Pages, and Google Business Profile adapters with real API publication, discovery, OAuth or service credentials, insights, and supported deletion flows.
- `social-posts` audit/idempotency collection, `social-templates` collection, and encrypted `socials-connections` global.
- Host-defined source resolvers, access control, copy transforms, templates, distributed coordination hooks, scheduling helpers, internal scheduler endpoints, and Payload Jobs task definitions.
- Optional image preflight and deterministic JPEG rendition pipeline.
- `authCollection` configuration with single-auth-collection auto-detection and explicit selection for multi-auth hosts.
- Explicit `publicationKey` identities for campaigns and `idempotencyKeyOverride` for adopting known legacy rows.
- Publisher-only resolution endpoint for ambiguous provider outcomes: `POST /posts/:postId/resolve`.
- CI matrices for Node 22/24, SQLite/PostgreSQL/MongoDB boot coverage, package validation, dependency audit, CodeQL, and Chromium/Firefox/WebKit admin E2E.

### Changed

- Requires Payload `^3.84.1` and Node.js `>=22.12.0`.
- Template scope contains only universal source fields plus `metadata.*`. The prerelease ecommerce aliases `category`, `color`, `material`, and `dimensions` were removed; use the corresponding host-defined `metadata` paths.
- Platform adapters are isolated per normalized plugin options, while job runner state and task options are isolated per Payload instance. Version `0.9.x` supports one plugin instance per Payload config.
- Native Facebook schedules and accepted GBP Local Posts remain pending until provider reconciliation confirms publication.
- Scheduled publication uses revision tokens, due-time checks, best-effort cancellation of superseded Payload jobs, and unique-key race recovery.
- `social-posts.publishedBy` targets the configured host auth collection and is omitted for hosts without auth collections.

### Fixed

- Unsafe provider `POST` requests are no longer replayed after network failures or ambiguous 5xx responses. Provider-success/audit-write failures capture the provider ID and are fenced as non-retryable unknown outcomes across all four adapters.
- Facebook delete reconciliation recognizes an already-absent upstream post only from typed HTTP/upstream 404 status, never provider message substrings.
- GBP default publication identity now includes the primary image; Pinterest legacy identities can be adopted without changing their hash.
- GBP `PROCESSING`, `LIVE`, and `REJECTED` states and Facebook native schedules now persist truthful lifecycle states and reconciliation timestamps.
- Facebook deletion resolves the Page from stored metadata for bare video IDs; adapter deletion no longer competes with endpoint-owned local transitions.
- Queue-drain failures propagate to callers; per-Payload drain deduplication no longer leaks across Payload instances.
- Pinterest requires a provider post ID and stores a Pinterest permalink rather than the outbound destination link.
- OAuth scope parsing accepts provider-delivered comma or whitespace separators and does not reject token responses that omit the optional scope echo.
- Admin authorization, import-map component registration, local-time scheduling bounds, media selection, template field discovery, and composer response guards were corrected and covered by tests.

### Security

- Remote image reads require HTTPS, reject credentials and nonstandard ports, revalidate every redirect, resolve and reject non-public IP ranges including IPv4-mapped and transition IPv6 addresses, pin each TLS connection to the validated address, enforce a timeout, and stream under a 25 MB cap.
- Pinterest video sources use the same redirect-aware pinned-IP transport plus their exact-host allowlist, and streamed bytes cannot exceed or differ from the declared bounded length.
- Stored access and refresh tokens use authenticated AES-256-GCM envelopes with key-ring rotation and no plaintext fallback.
- Secret-bearing values are recursively redacted before reaching host loggers.
- Meta webhook bodies are size-bounded and authenticated with `X-Hub-Signature-256` before callbacks run.
- Internal scheduler API keys are compared through fixed-length SHA-256 digests with `timingSafeEqual`.

### Migration

- This release changes plugin-owned schemas, including publication status values and the optional `publishedBy` relationship. Hosts must run `payload migrate:create`, inspect the generated migration, and apply it through their normal deployment process. The plugin never creates or runs migration files.

## [0.9.0] - 2026-07-12

### Added

- Private prerelease containing the initial four adapters, admin composer, encrypted connection storage, source resolver registry, templates, scheduling, insights, and audit collection.

[Unreleased]: https://github.com/ContiDigital/payload-plugin-socials/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/ContiDigital/payload-plugin-socials/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/ContiDigital/payload-plugin-socials/releases/tag/v0.9.0
