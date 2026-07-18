# Changelog

All notable changes to `payload-plugin-socials` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Standalone composer UI.** The `/admin/socials` route now renders a two-tab layout (Compose | Connections). The Compose tab hosts a standalone multi-channel composer that posts inline content to every selected channel through `POST {basePath}/compose/publish`. Per-channel destination pickers, format selects, and result feedback (success with external link, or error) are included. The existing Connections widget lives on the second tab.
- **Media library browser.** An "Add media" row under the composer media grid uses `useListDrawer` from `@payloadcms/ui` to open any upload-enabled collection. On select, the chosen document is fetched via the REST API and appended as a media asset. When the source document is webp or avif and has jpeg sizes, the largest jpeg size URL is preferred.
- **Add media by URL.** An inline URL input with a type select (image/video) appends an asset to the composer media list from any public URL.
- **Title input for Instagram and Facebook.** An optional "Title (first line)" input prepends the title plus a blank line to the caption or message at compile time. Pinterest retains its existing dedicated title field.
- **`acceptedMediaTypes` helper.** Pure function returning the accepted media types (`image`, `video`, or both) for any `(platform, format)` combination. Used by the UI to disable and filter assets, and by `compileComposerInput` to enforce strict selection.
- **Format-to-media coherence.** Assets whose type does not match the current format render disabled (dimmed, not clickable, tooltip "Not available for this format"). On format change, incompatible selected media is pruned and a toast reports what was removed.
- **`MediaAssetFormat` field** on `SocialDraftMedia` (optional `format` string from mimeType). Threaded through `compileComposerInput` output so a downstream image-format-safety preflight can use it.
- **`StandaloneComposerState` and `compileStandalonePublishBody`** in the model layer: pure functions for the standalone composer's state shape and its publish body compilation.
- **`SocialsAdminViewClient`** client component exported from `payload-plugin-socials/client`.

### Changed

- **Platform tabs redesigned.** The right-aligned text pills are replaced with a full-width segmented control directly under the panel header. Equal-width buttons, strong active state, and a per-platform brand accent (3px bottom border: Pinterest #e60023, Instagram #e1306c, Facebook #1877f2, GBP #4285f4) on the active segment. Retains `role=tablist` semantics and keyboard support.
- **`compileComposerInput` strict media selection.** The silent wrong-type fallback is removed. Only selected assets whose type matches the format are used. If nothing is selected and the draft has exactly one accepted asset, that one is auto-used. Otherwise validation reports the missing media instead of silently picking the wrong type.
- **Feedback uses toast.** Inline error/success paragraphs and `window.confirm`/`window.alert` in the composer and `SocialsDashboardWidget` are replaced with `toast` from `@payloadcms/ui`. The disconnect action uses a two-step confirm button (click "Disconnect", then "Confirm disconnect") instead of `window.confirm`.
- **`SocialsAdminView`** now renders a client island (`SocialsAdminViewClient`) with two tabs instead of the connections widget alone.
- **`SocialPublishPanelClient`** accepts a `mode` prop (`'source'` default, or `'standalone'`). In standalone mode the component renders the multi-channel composer without `useDocumentInfo`.
- **Config-first copy transformations (`transformations` option).** Operators can now declare per-field copy transforms in the plugin config, keyed by source kind (and an optional `'*'` wildcard). Each value is either a `{{ variable | filter }}` template string rendered through the existing interpolation engine, or a function that receives the `SocialSourceContext` directly. The new `transformations` option covers all seven canonical copy fields: `pinterestTitle`, `pinterestDescription`, `pinterestAltText`, `pinterestHashtags`, `instagramCaption`, `facebookMessage`, and `gbpSummary`. It is a higher-precedence, source-kind-aware superset of the existing `copyOverrides` option; `copyOverrides` continues to work unchanged and is still the right choice for simple global function overrides. The precedence chain is: kind-specific transform, then wildcard transform, then `copyOverrides`, then the built-in default.

## [0.9.0] - 2026-07-12

### Added

- **Reusable post templates.** A plugin-owned `social-templates` collection (edited with Payload's built-in collection admin) holds per-channel template strings. A safe `{{ variable | filter }}` interpolation engine (`renderTemplate`, `buildTemplateScope`, `resolveTemplateCopy`) fills them per source record. It has no `eval`, drops missing values to an empty string instead of `[object Object]`, and short-circuits `__proto__`, `constructor`, and `prototype` so a template cannot reach the prototype chain. Filters: `upper`, `lower`, `trim`, `truncate:N`, `default:text`.
- **Standalone cross-channel composer.** Compose one post from inline content and publish it to every selected channel through `POST {basePath}/compose/publish`, with per-channel error isolation (one channel failing never blocks the rest). Exposed programmatically as `buildStandaloneContext` and `composeAndPublish`. A reserved `standalone` source kind plus a content-hash `sourceId` keep the existing idempotency behavior intact.
- **Per-platform image asset pipeline.** `preflightImage` validates an image against each platform's published constraints (format, min and max width, byte bounds, accepted aspect band) and returns blocking errors plus fixable warnings. `resolveTargetDimensions` clamps the width into the platform band and snaps an off-band aspect to a cover crop or an inside downscale. `transformImage` executes the spec with sharp (an optional peer dependency). `PLATFORM_IMAGE_CONSTRAINTS` is exported for use in host UIs.
- **Scheduling: full bring-your-own-scheduler contract.** The plugin defines task definitions but does not own the cadence. Three integration modes that compose freely:
  - Native Payload Jobs `autoRun` (plugin registers the cron entry when `scheduling.autoRun.cron` is set).
  - External cron (AWS EventBridge / Vercel cron / GitHub Actions / etc.) hitting `/internal/jobs/sweep` and `/internal/jobs/run` with a pre-shared API key.
  - Long-running worker process calling `runQueuedSocialsJobs(payload)` directly.
- **Scheduled publishing.** `POST /:platform/:sourceKind/:sourceId/publish` now accepts `scheduledAt` (ISO-8601 >=60s in the future). The plugin snapshots the publish input into a `queued` `social-posts` row + queues the publish task with `waitUntil`. When the task fires, the source context is re-resolved and the adapter publishes the snapshot.
- **Internal scheduler HTTP endpoints (API-key gated):**
  - `POST /internal/jobs/sweep`: sweep due posts and drain the queue
  - `POST /internal/jobs/run`: drain the queue only
  - `POST /internal/jobs/queue/:taskSlug`: queue a specific task with the body as input
  - `POST /internal/posts/:postId/retry`: retry a failed or cancelled post
  - `POST /internal/insights/refresh`: fire an insights refresh now
  - `POST /internal/connections/refresh`: fire a connection refresh now
- **Five plugin-owned tasks registered on `config.jobs.tasks`:** `socialPostPublish`, `socialPostRetry`, `socialPostSweep`, `socialInsightsRefresh`, `socialConnectionRefresh`. All on the `socials` queue by default.
- **Queue helpers exported:** `queueSocialPostPublish`, `queueSocialPostRetry`, `queueSocialPostSweep`, `queueSocialInsightsRefresh`, `queueSocialConnectionRefresh`, `scheduleSocialPostPublish`, `runQueuedSocialsJobs`, `sweepDueSocialPosts`.
- **`scheduling` plugin option** with `internalApiKey`, `autoRun.{cron,insightsRefreshCron,connectionRefreshCron,queue}`, `sweepBatchSize`, `drainBatchSize`, `connectionRefreshWindowSeconds`, `insightsRefreshWindowSeconds`.
- **Four-platform insights.** Pinterest Pin analytics, media-type-aware Instagram insights, current Facebook Page post metrics, and Google Business Profile LocalPost action totals all persist normalized snapshots through `socialInsightsRefresh`.
- **Production admin surfaces.** The injected `SocialPublishPanelClient` is a purpose-built, editor-independent social composer with typed per-platform formats, ordered media, resolved templates, live server validation, accessible previews, immediate publishing, scheduling, and history. The dashboard reports live connection state and exposes connect/disconnect controls.
- **Canonical `SocialDraft`.** Preview responses expose a versioned, channel-neutral copy and media model. Host Lexical, Slate, or custom-block documents remain behind `SourceContextResolver`; arbitrary editor JSON never becomes an adapter payload.
- **Pinterest video Pins.** The documented register, bounded streaming upload, processing poll, and create flow is implemented with HTTPS source-host allowlisting. Organic carousel support is no longer falsely advertised because Pinterest exposes carousel creation as an ads format.
- **Distributed coordination hooks.** Hosts can supply a fenced `withLock` implementation for rotating Pinterest tokens and `acquireRequestLease` for fleet-wide outbound quotas while retaining the plugin's local limiter.
- **Zero-downtime encryption-key rotation.** `previousEncryptionKeys` forms a temporary decryption ring; credentials read with an old key are immediately rewritten under the current primary key.
- **Upstream disconnect revocation.** Google and Meta OAuth grants are revoked before local credential erasure. Shared Meta-app grants clear both affected platform records, and config-managed credentials fail closed instead of pretending to disconnect.
- **Verified Meta webhooks.** Facebook and Instagram webhook verification and receive endpoints enforce the hub token, a 1 MB body cap, and `X-Hub-Signature-256` before invoking the host callback.
- **Outbound request policy.** Platform and OAuth traffic now honors configured concurrency, requests-per-minute, timeout, retry, and bounded-queue settings.
- **Public release automation.** GitHub Actions runs the complete release check on pull requests and publishes npm releases with trusted provenance.
- **Cross-database and browser release matrices.** CI boots and round-trips the real plugin schema on SQLite, PostgreSQL 17, and MongoDB 8, then exercises the admin composer in Chromium, Firefox, and WebKit with an axe accessibility scan.
- **Bounded insights concurrency.** Refresh workers process posts concurrently up to `rateLimit.maxConcurrency`; outbound provider quotas still flow through the local and optional distributed request leases.
- **Security automation.** Pinned CodeQL and dependency-review workflows supplement the production dependency audit in `release:check`.
- **`social-posts` scheduling fields:** `scheduledAt`, `queuedJobId`, `nextRetryAt`. `meta.queuedInput` snapshots the publish input for the scheduled task to replay.
- **`apiKeyAuth` utility.** Constant-time API-key comparison via `crypto.timingSafeEqual`, with length-independent timing flatness (different-length tokens still go through a sha-256 compare).
- **Phase 1-7 platform adapters all shipped:**
  - **Pinterest** (Phase 1): OAuth + continuous refresh, `GET/POST/PATCH/DELETE /v5/pins`, multi-step video upload, board CRUD, idempotent publish, analytics, delete.
  - **Google Business Profile** (Phase 3): OAuth + service-account JWT bearer flow, account/location discovery (v1 sub-APIs), LocalPosts CRUD (legacy v4), all four topic types (STANDARD/EVENT/OFFER/ALERT), per-topic structural validation, idempotent publish.
  - **Instagram Business** (Phase 5): Facebook Login + long-lived (60-day) token exchange + system-user token support, IG account discovery from Page, container create + status poll + media_publish flow, IMAGE / REELS / STORIES / CAROUSEL (2-10 children) publishing, caption length + hashtag + mention validation.
  - **Facebook Pages** (Phase 7): Shared Meta Login flow with Instagram, Page discovery + Page-token derivation, LINK / PHOTO / PHOTO_MULTI / VIDEO formats, schedule-in-future support (10 min - 75 days for feed, 6 months for videos).
- **Plugin foundation:**
  - Curried factory `payloadPluginSocials(options)(config) => Config` mirroring the GMC plugin pattern.
  - Single canonical `social-posts` collection + `socials-connections` global.
  - AES-256-GCM encrypted envelope for all stored OAuth tokens (host-supplied 32-byte key, validated at boot).
  - Source-polymorphic resolver registry, where the host registers resolvers keyed by `sourceKind`.
  - Platform adapter registry, instantiated lazily per the `platform.enabled` flag.
  - Source-polymorphic publish endpoints (`/:platform/:sourceKind/:sourceId/{preview,publish,history}`).
  - Logger with token redaction (`access_token`, `refresh_token`, `client_secret`, etc.).
  - Plugin-internal exception classes (`PluginError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `RateLimitedError`, `PlatformApiError`).
  - Admin pieces (`SocialsNavLink`, `SocialsDashboardWidget`, `SocialsAdminView`, `SocialPublishPanelClient`).

### Fixed

- Immediate and scheduled publication races now claim rows atomically before external calls; concurrent identical requests cannot create duplicate platform posts.
- Custom Payload queue names are used consistently for both enqueue and drain operations.
- `socialConnectionRefresh` now performs proactive token refresh for Pinterest, Instagram, Facebook, and GBP.
- Disconnect clears both encrypted credentials and warm in-process token caches.
- Meta Page requests use Page-scoped bearer tokens and matching `appsecret_proof` values without putting tokens in request bodies.
- OAuth state values are no longer returned in JSON, callback failures clear state cookies, and persisted/logged error messages redact embedded credentials.
- Source resolvers are validated at their boundary, strict base64 decoding rejects malformed encryption envelopes, and externally configurable Meta API versions are validated.

### Security

- The `socials-connections` global rejects direct admin updates; plugin services remain the only credential write path.
- Access-token diagnostics that derived identifiers from Page tokens were removed.
- All server-side external HTTP calls are covered by abortable request timeouts.

### Notes

- Pre-1.0: minor versions may include breaking changes; pin exact versions.
- **Runtime baseline:** Node.js 22.12 or newer is required.
- **Schema additions on first install**: 2 collections (`social-posts`, `social-templates`) and 1 global (`socials-connections`). Run `pnpm payload migrate:create` after install to generate a migration; the plugin never auto-creates migrations.
- **Facebook video publishing uses Meta's public-CDN `file_url` ingestion**: local-file and resumable-session upload are outside the v1 source contract.

---

## How to read this changelog

- **Added**: new features
- **Changed**: changes to existing functionality
- **Deprecated**: soon-to-be-removed features
- **Removed**: removed features
- **Fixed**: bug fixes
- **Security**: vulnerability fixes
- **Notes**: operational implications (cache invalidation, env vars to set, migrations required, and so on)

Versions follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.
