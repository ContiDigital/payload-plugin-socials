# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-10-22

### Added

- Deferred publishing: the composers send `X-Socials-Publish-Async: 1` and, when a host answers `202` with `X-Socials-Publish-Status: pending` and a same-origin `Location` under `{basePath}/requests/{id}`, poll that status URL (honoring a clamped `Retry-After`) until the original provider response arrives. The publish request is submitted once; polling stops after ten minutes with a message that points at post history. The header names and path segment are exported constants.
- `assets.normalize` re-encodes every image, including accepted formats, into a bounded JPEG rendition: EXIF orientation applied, transparency flattened to white, sRGB, metadata stripped, fitted without cropping onto a per-platform canvas (Facebook within 2048 pixels at its own proportions, Instagram stories 1080 by 1920, everything else a 1080 pixel square). Sources decode within a 64 megapixel budget and results must fit the platform byte limit. Renditions are cached per source URL, platform, presentation and quality.
- `assets.maxSourceImageBytes` (default 25 MiB) sets the download budget for conversions, `assets.maxConcurrentConversions` (default 1) bounds concurrent conversions per process so carousel and multi-photo publishes cannot exhaust worker memory, and `assets.renditionData` supplies required field values for rendition documents.
- `admin.mediaLibrary` scopes the composers' media library drawer to specific upload collections and serializable `Where` filters.
- The source composer's media pool has a search box, a visible count of matching and selected items, lazy-loaded tiles, captions from alt text that stay clear of the reorder controls, and select buttons named after the asset's alt text.

### Changed

- Instagram stories resolve their image with a `story` presentation so normalized renditions use the vertical canvas.
- Rendition conversions run through a process-wide limiter; a failed conversion releases its slot so later images still publish.
- The source composer remounts per record, so selections, search and fetched previews no longer carry over when the admin navigates between documents in place.

### Fixed

- Business Profile: a verified location (voice of merchant) is postable even when Google omits `canOperateLocalPost`, which Business Information v1 does for listings that take posts. Such locations were hidden from the location picker.

### Notes

- No plugin-owned schema changes; no host migration required. Defaults are unchanged: without `assets.normalize`, accepted formats pass through and unsupported formats transcode exactly as before, with the same rendition file names.

## [0.9.3] - 2026-07-23

### Added

- Opt-in, per-platform live lifecycle canaries exercise the real Pinterest, Facebook, and Instagram adapters. Pinterest and Facebook verify cleanup; Instagram requires a second residue opt-in and uses a self-expiring Story. The release runbook records preflight, canary evidence, tagging, npm bootstrap, and trusted-publishing ownership.

### Changed

- **Scheduling now follows the operator-owned model.** The plugin no longer writes to your `jobs.autoRun` array. When `scheduling.autoRun` crons are set, the plugin attaches Payload task-level `schedule` entries to its sweep/insights/connection tasks; you run a Payload Jobs worker that handles schedules and drains the queue (or use the internal endpoints / worker helpers). The previous behavior registered `autoRun` entries that only drained the queue and never enqueued the periodic tasks, so insights-refresh, connection-refresh, and the sweep silently never ran under that mode.
- `scheduling.autoRun.cron` is now optional; set only the refresh crons if you drive the sweep another way. Providing any one cron registers the block (previously the whole block was dropped unless the sweep cron was present).
- The task queue is now configured as `scheduling.queue`, independently of native task crons. The former `scheduling.autoRun.queue` nesting has been removed.
- A Payload config may contain only one plugin instance; applying a second now fails during config construction instead of creating first-wins/last-wins task registry behavior.
- The standalone multi-channel composer is split from the source-record composer, and its publish success/error orchestration is covered in the three-browser Playwright suite.
- Payload admin peers now require React and React DOM 19, matching the supported Payload 3 runtime.
- Public copy guidance now documents the optional commerce-style metadata convention used by Pinterest defaults and the provider-conditional availability of GBP Alert posts.
- npm provenance now comes from the steady-state trusted-publishing workflow rather than a package-level flag that prevents the one-time token bootstrap. The owner runbook reserves the package with a tagged, non-`latest` bootstrap prerelease before the real release workflow runs.

### Fixed

- Facebook stores the canonical post permalink returned by the Graph API, falling back to the redirect-safe bare `/{post_id}` URL when the lookup fails (never the `/{page_id}/posts/{post_id}` form, which 404s on new-experience Pages). Scheduled posts receive the canonical URL during reconciliation.
- Google Business Profile derives its idempotency key from the original image URL, so `assets.autoConvert` can no longer split a single publication into two `social-posts` rows.
- When `disabled`, the plugin retains hidden, deny-all, hook-free collection/global schemas so a host `migrate:create` run cannot generate a destructive drop; runtime endpoints, tasks, and admin surfaces remain absent. Schema-driving `sources` are still required.
- Host-collection Socials tab injection is idempotent and rejects a host field named `socials` with a clear collision error.
- Pinterest rejects an unknown `environment` value rather than silently routing a typo to production.
- Provider delete failures raise a sanitized platform error carrying the true upstream status instead of a 400 with the raw upstream body.
- Log redaction also masks bare provider token shapes (`pina_`, `pinr_`, `ya29.`, `EAA…`) that appear outside secret-named keys.
- Facebook insights use Meta's post media-view replacements instead of the impressions/reach/3-second-view metrics retired in June 2026. Facebook and Instagram now retry invalid-metric Graph code-100 failures per metric, preserve valid partial results, and record rejected names in `unavailableMetrics`; missing-object and permission-loss responses are rethrown instead of becoming empty snapshots.
- Shared image-format validation and retry-delay helpers replace adapter-local duplicates; the unused standalone Instagram delete export is removed.
- The clean script now removes `dist` and both TypeScript build-info files portably instead of relying on shell brace expansion, preventing stale build artifacts from entering a release.
- Injected source composers no longer assume a `product` source kind. A missing or blank `sourceKind` now renders a configuration error before access or source requests can run.

### Security

- The optional `sharp` peer now requires `^0.35.0`, and the development image pipeline runs against `0.35.3`, excluding libvips builds affected by the 2026 inherited Sharp advisories.
- Updated Next.js and pinned patched compatible transitive versions of PostCSS, fast-uri, brace-expansion, Mongoose, and Sharp. CI now audits the complete dependency graph at high severity instead of checking only published runtime dependencies; the sole incompatible dev-tooling-only brace-expansion advisory is explicitly documented in `audit-allowlist.json`.

### Notes

- No plugin-owned schema changes; no host migration required.
- JavaScript source maps are no longer included in the package tarball.

## [0.9.2] - 2026-07-22

### Fixed

- Preserve Payload/Pino as the receiver of logger methods and contain host logger failures so successful credential persistence, publication, scheduler, retry, and error-response operations cannot be converted into application failures by logging.
- Separate Pinterest authorization-scope serialization from token-response parsing, parse response scopes consistently during authorization-code exchange and refresh, and preserve stored scope metadata when Pinterest omits the response field.

### Notes

- Added a production board-discovery regression test (token refresh → encrypted persistence → real Pino logging → token caching → repeated board requests).
- This patch has no plugin-owned schema changes and requires no host migration.

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

[Unreleased]: https://github.com/ContiDigital/payload-plugin-socials/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/ContiDigital/payload-plugin-socials/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/ContiDigital/payload-plugin-socials/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/ContiDigital/payload-plugin-socials/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/ContiDigital/payload-plugin-socials/compare/d41a1c7d0fb88346e6dfb0c10ea3480d768042e4...v0.9.1
[0.9.0]: https://github.com/ContiDigital/payload-plugin-socials/commit/d41a1c7d0fb88346e6dfb0c10ea3480d768042e4
