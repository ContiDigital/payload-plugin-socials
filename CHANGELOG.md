# Changelog

All notable changes to `payload-plugin-socials` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- **Every admin UI surface is now hidden from users the host `authorize` rejects.** The REST endpoints were correctly gated, but the admin UI rendered for any logged-in admin-panel user: the "Socials" nav link showed in the sidebar, `/admin/socials` rendered, and the dashboard widget mounted and then error-toasted on its 403. A user `authorize` denies for the `publisher` scope now sees nothing. The new read-only `GET {basePath}/access` endpoint reports `{ admin, publisher }` for the current user and never throws (unauthenticated or a throwing `authorize` reads as all-false). The `/admin/socials` view (an RSC) evaluates `authorize` server-side and redirects to the admin home when denied, so the route is unreachable rather than an error page. The nav link, dashboard widget, and both composer surfaces (source-mode and standalone) probe `/access` once on mount, render nothing until it resolves, and mount their content only for a `publisher` — so their preview, history, destination, and connection fetches never fire for an unauthorized user, and no error toast is ever raised. The connection-health fetch also no longer toasts on a non-ok response. Two pure helpers back the branching: `parseAccessResponse` and `resolveSocialsEndpointBase` in `accessModel.ts`, plus `evaluateAuthorize`/`checkAccess` in the server access utility, all unit-tested.
- **Template builder fields now render and look native.** The dev harness's committed import map predated `SocialTemplateFieldBuilder`, so the seven template fields rendered as an empty group; the import map is regenerated and committed, and the README consumer note applies to hosts (`payload generate:importmap` after install/upgrade). Each field also gains a visible label (for example "Pinterest title", "Instagram caption") and full styling on Payload theme variables; the builder previously referenced style classes that existed in no stylesheet.
- **Instagram and Facebook no longer duplicate the title into the message.** The default copy builders put the source title on the first line of the body while the composer's "Title (first line)" field prepends it again at compile time. The composer now strips the leading title from the initialized message (`stripLeadingTitle`) and the compile step skips the prepend when the message already starts with the title.
- **The preview pane now renders video and always mirrors the publish.** Selected video assets render as a playable video element, and the preview derives its media from the same `getEffectiveAssets` rule the compiler uses (explicit selection, else the single accepted asset), so an auto-selected asset shows in the preview instead of an empty pane.

### Changed

- **`socials-connections` global is now fully hidden from the admin UI.** `admin.hidden` was a function that showed the global to any logged-in user; it is now `true`, so the global never appears in the admin nav or as an editable document view. This global is internal AES-256-GCM token storage, and hand-editing the encrypted envelopes corrupts the tokens. Operators manage connections from the Connections tab in the plugin admin view. API and access behavior are unchanged.
- **Config-managed connections render as connected with a badge and no action.** The Connections tab now shows platforms whose credentials come from server configuration (system-user or service-account tokens, `managedByConfig: true`) as connected, with their account label and a "Managed by server configuration" badge, and renders no Connect or Disconnect button. Previously these rows showed a disabled "Configured" button. The disconnect endpoint 409s for managed connections, so the UI no longer offers an action that always fails. OAuth-based platforms keep their existing Connect and two-step Disconnect behavior. The row view-model moved into a pure, tested `connectionRowModel.ts` helper.
- **Dev harness enables image auto-conversion.** `dev/payload.config.ts` now sets `assets: { autoConvert: true, renditionCollection: 'media' }` so local testing exercises the WebP/PNG to JPEG conversion path that production hosts (whose media is not JPEG) must enable.

### Fixed

- **Plugin config no longer invisible to client components on Payload 3.86.** `applyAdminEnhancements` now writes the socials object to both `config.custom.socials` (server-side readers) and `config.admin.custom.socials` (the path that survives `buildClientConfig`), so `useConfig()` in the browser receives `enabledPlatforms`, `apiBasePath`, `sourceKinds`, and `adminRoute`. Platform tabs in the source composer, the Channels list in the standalone composer, and the template builder record-picker all populate correctly instead of rendering empty.
- **OAuth callback no longer 404s after a successful connection.** The post-authorization redirect in `oauthEndpointFactory` previously linked to the bare plugin route (e.g. `/socials?connected=...`), which 404s because the view is mounted under the Payload admin base. The factory now reads `options.admin.adminBase` (populated by `applyAdminEnhancements` from `config.routes.admin`) and redirects to the correct full path (e.g. `/admin/socials?connected=...`). The `SocialsAdminViewClient` reads the `connected` query param on mount, switches to the Connections tab, fires a success toast naming the platform, and strips the param from the URL.
- **Standalone composer no longer white-screens on server errors.** The `publish()` handler in `StandaloneComposer` previously cast the response body to `ComposeResult` unconditionally; a 403, validation error, or 5xx response with `{ error }` caused `results.results.map` to throw. The body is now validated via the new pure `parseComposeResponse` helper before `setResults` is called; error responses toast the message and leave the UI intact.
- **User-added media is no longer wiped when switching platform tabs.** The per-platform preview-fetch effect in `SourceComposer` previously ran on every tab activation, overwriting the envelope and destroying any media the user added via Add URL or the Media library. The effect now skips the fetch when an envelope already exists for that platform (cache-first, using the new `shouldFetchEnvelope` helper), so user additions survive tab switches.
- **Media library drawer now closes when a file is selected.** `useListDrawer` returns `closeDrawer` as the third element of its tuple but neither composer destructured it, leaving the drawer open after selection. Both `SourceComposer` and `StandaloneComposer` now call `closeDrawer()` at the top of their `onSelect` handlers.
- **Schedule picker no longer uses UTC wall-clock as its local-time minimum.** The `min` attribute on the `<input type="datetime-local">` was set to `new Date().toISOString().slice(0, 16)`, which returns UTC wall-clock. A `datetime-local` input interprets `min` in the browser's local timezone, so operators in UTC-5 found the next five hours forbidden while operators in UTC+2 could accidentally pick a time already in the past. A new pure helper `formatLocalDateTimeMin` in `socialComposerModel.ts` reads local date-part getters (`getFullYear`, `getMonth`, `getDate`, `getHours`, `getMinutes`) to produce a string that matches the browser's own interpretation. The helper is fully testable with a fixed `Date` argument.
- **Past or near-future `scheduledAt` no longer silently publishes immediately.** The publish endpoint previously fell through to an immediate live post when `scheduledAt` was in the past or within the 60-second grace window. A user mistake (wrong date, already-elapsed time) was turned into an instant publish. The endpoint now returns HTTP 400 `ValidationError` with a message telling the operator to pick a future time or omit `scheduledAt` entirely; the adapter is never called and no row is claimed.
- **Scheduled time is now visible in the history list.** `HistoryRow` previously carried no `scheduledAt` field. The history endpoint response now includes `scheduledAt` on every row, and queued rows in the history list render "scheduled for [local date-time]" instead of a blank time field, so operators can see when a post is due to go out.
- **Queued posts can now be cancelled from the UI.** The delete endpoint only accepted `published` rows; calling it on a `queued` row returned a 400 error and there was no way to remove a mistakenly scheduled post. The endpoint now detects `status === 'queued'` before checking for `externalId`: it transitions the row to `status: 'cancelled'`, stamps `meta.cancelledAt` and `meta.cancelledBy`, and returns `{ ok, postId, status: 'cancelled' }` without making any upstream API call. The `cancelled` status is already in `RECLAIMABLE_STATUSES`, so the row is immediately eligible for republish-in-place. The history panel shows a two-step "Cancel / Confirm cancel" action for queued rows, consistent with the existing delete confirm pattern.

### Added

- **`formatLocalDateTimeMin(date: Date): string` exported from `socialComposerModel`.** Pure helper that formats a `Date` into the `YYYY-MM-DDTHH:MM` string that `<input type="datetime-local">` expects as its `min` attribute, using local date getters rather than UTC. Passing a fixed `Date` in tests makes the output fully deterministic.
- **Published-post deletion endpoint (`DELETE {basePath}/posts/:postId`).** A publisher-gated REST endpoint that removes a published social post upstream and soft-deletes the local `social-posts` row. The handler loads the row, verifies it is published with an `externalId`, calls the platform adapter's `delete` method (a 404 or "not found" response from the upstream platform is treated as success, making the operation idempotent), then updates the row to `status: 'deleted'` and records `meta.deletedAt` and `meta.deletedBy`. The row is never hard-deleted: it remains the audit record and idempotency anchor for future republishes.
- **Delete action in the history panel.** The history list in `SocialPublishPanelClient` now shows a per-row Delete button for `published` Pinterest, Facebook, and GBP entries. The action uses the same two-step confirm pattern as the disconnect button: the first click arms the button, a second click confirms and calls `DELETE {basePath}/posts/{id}`. A toast reports success or the upstream error. The history list refreshes automatically after deletion.
- **Mark-deleted reconcile action for Instagram.** Published Instagram rows in the history panel show "Mark deleted (removed in app)" instead of a Delete button. This calls `DELETE {basePath}/posts/:postId?localOnly=true` after the same two-step confirm. Use this after manually removing a post in the Instagram app to keep the local ledger in sync.
- **`?localOnly=true` reconcile path on `DELETE {basePath}/posts/:postId`.** Skips all upstream platform calls for any platform and soft-deletes the local row only (`status: 'deleted'`, `meta.deletedAt`, `meta.deletedBy`, `meta.deletedLocalOnly: true`). The same published and externalId guards apply. The resulting `deleted` row is re-claimable for republish-in-place, exactly like rows deleted via the normal path.
- **Republish-in-place for deleted rows.** `reservePublication` now treats `deleted` rows as re-claimable, alongside `cancelled`, `draft`, and `failed`. Publishing the same content after deletion reuses the existing row (same `id`, same idempotency key) and transitions it back to `published`. No duplicate row is ever created. This applies to both normally-deleted and locally-deleted rows.
- **`'deleted'` post status.** `POST_STATUSES` in `src/constants.ts` now includes `'deleted'` as a valid lifecycle state. This is a schema change: Postgres hosts must run `payload migrate:create` and then `payload migrate` after upgrading.

### Changed

- **Instagram API deletion removed as a capability.** Meta's Graph API does not expose a delete endpoint for published Instagram Business media (`DELETE /{ig-media-id}` always returns `OAuthException` code 10). The Instagram adapter's `delete` method now throws immediately with an actionable message rather than making a network call that would always fail. Calling `DELETE {basePath}/posts/:postId` on an Instagram row returns HTTP 422 with the same message; the local row is left untouched. Use `?localOnly=true` to reconcile the ledger after removing a post in the Instagram app.

### Notes

- **Schema change.** The `'deleted'` value added to `POST_STATUSES` is stored in the `soc_post_status` enum column on the `social-posts` table. Postgres hosts must generate and apply a migration after upgrading: run `pnpm payload generate:types`, then `pnpm payload migrate:create add_deleted_post_status`, then `pnpm payload migrate`. SQLite and MongoDB hosts do not require a migration for this change.

- **Standalone composer UI.** The `/admin/socials` route now renders a two-tab layout (Compose | Connections). The Compose tab hosts a standalone multi-channel composer that posts inline content to every selected channel through `POST {basePath}/compose/publish`. Per-channel destination pickers, format selects, and result feedback (success with external link, or error) are included. The existing Connections widget lives on the second tab.
- **Media library browser.** An "Add media" row under the composer media grid uses `useListDrawer` from `@payloadcms/ui` to open any upload-enabled collection. On select, the chosen document is fetched via the REST API and appended as a media asset. When the source document is webp or avif and has jpeg sizes, the largest jpeg size URL is preferred.
- **Add media by URL.** An inline URL input with a type select (image/video) appends an asset to the composer media list from any public URL.
- **Title input for Instagram and Facebook.** An optional "Title (first line)" input prepends the title plus a blank line to the caption or message at compile time. Pinterest retains its existing dedicated title field.
- **`acceptedMediaTypes` helper.** Pure function returning the accepted media types (`image`, `video`, or both) for any `(platform, format)` combination. Used by the UI to disable and filter assets, and by `compileComposerInput` to enforce strict selection.
- **Format-to-media coherence.** Assets whose type does not match the current format render disabled (dimmed, not clickable, tooltip "Not available for this format"). On format change, incompatible selected media is pruned and a toast reports what was removed.
- **`MediaAssetFormat` field** on `SocialDraftMedia` (optional `format` string from mimeType). Threaded through `compileComposerInput` output so a downstream image-format-safety preflight can use it.
- **`StandaloneComposerState` and `compileStandalonePublishBody`** in the model layer: pure functions for the standalone composer's state shape and its publish body compilation.
- **`SocialsAdminViewClient`** client component exported from `payload-plugin-socials/client`.
- **Config-first copy transformations (`transformations` option).** Operators can now declare per-field copy transforms in the plugin config, keyed by source kind (and an optional `'*'` wildcard). Each value is either a `{{ variable | filter }}` template string rendered through the existing interpolation engine, or a function that receives the `SocialSourceContext` directly. The new `transformations` option covers all seven canonical copy fields: `pinterestTitle`, `pinterestDescription`, `pinterestAltText`, `pinterestHashtags`, `instagramCaption`, `facebookMessage`, and `gbpSummary`. It is a higher-precedence, source-kind-aware superset of the existing `copyOverrides` option; `copyOverrides` continues to work unchanged and is still the right choice for simple global function overrides. The precedence chain is: kind-specific transform, then wildcard transform, then `copyOverrides`, then the built-in default.
- **Template builder UI (`SocialTemplateFieldBuilder`).** Each of the seven copy fields in the `social-templates` collection now mounts a structured field component instead of a plain textarea. The builder provides a token picker (static scope tokens from `buildTemplateScope` plus `metadata.*` keys discovered from a chosen sample record), a filter menu (`truncate:N`, `default:...`, `upper`, `lower`, `trim`), a per-field character count with platform-limit warning, and a debounced live preview that renders the current draft against a real record. A raw-string toggle reveals a plain input or textarea as an escape hatch. The underlying stored value remains a `{{ path | filter }}` template string, so no migration is required.
- **Template preview endpoint (`POST {basePath}/templates/preview`).** Body: `{ sourceKind, sourceId, fields }`. Returns `{ resolved, scopeKeys }` where `resolved` is the per-field rendered copy and `scopeKeys` is the full list of available token paths (static aliases plus any `metadata.*` keys present on the resolved record). Admin-gated via `assertAccess(req, options, 'admin')`.
- **`sourceKinds` in `config.custom.socials`.** `applyAdminEnhancements` now adds `sourceKinds: [{ kind, collection, label }]` derived from `options.admin.injectInto`. Client components read this to populate the record-picker dropdown without hard-coding collection slugs.
- **`SocialTemplateFieldBuilder` added to the `payload-plugin-socials/client` export surface.**

### Changed (from previous)

- **Platform tabs redesigned.** The right-aligned text pills are replaced with a full-width segmented control directly under the panel header. Equal-width buttons, strong active state, and a per-platform brand accent (3px bottom border: Pinterest #e60023, Instagram #e1306c, Facebook #1877f2, GBP #4285f4) on the active segment. Retains `role=tablist` semantics and keyboard support.
- **`compileComposerInput` strict media selection.** The silent wrong-type fallback is removed. Only selected assets whose type matches the format are used. If nothing is selected and the draft has exactly one accepted asset, that one is auto-used. Otherwise validation reports the missing media instead of silently picking the wrong type.
- **Feedback uses toast.** Inline error/success paragraphs and `window.confirm`/`window.alert` in the composer and `SocialsDashboardWidget` are replaced with `toast` from `@payloadcms/ui`. The disconnect action uses a two-step confirm button (click "Disconnect", then "Confirm disconnect") instead of `window.confirm`.
- **`SocialsAdminView`** now renders a client island (`SocialsAdminViewClient`) with two tabs instead of the connections widget alone.
- **`SocialPublishPanelClient`** accepts a `mode` prop (`'source'` default, or `'standalone'`). In standalone mode the component renders the multi-channel composer without `useDocumentInfo`.
- **Template authoring UX.** The raw `{{ }}` textarea help text on the seven copy fields has been replaced by the structured builder component. The raw-string toggle restores the previous experience for operators who prefer to write templates by hand.

## [0.9.0] - 2026-07-12

### Added

- **Config-first copy transformations (`transformations` option).** Operators can now declare per-field copy transforms in the plugin config, keyed by source kind (and an optional `'*'` wildcard). Each value is either a `{{ variable | filter }}` template string rendered through the existing interpolation engine, or a function that receives the `SocialSourceContext` directly. The new `transformations` option covers all seven canonical copy fields: `pinterestTitle`, `pinterestDescription`, `pinterestAltText`, `pinterestHashtags`, `instagramCaption`, `facebookMessage`, and `gbpSummary`. It is a higher-precedence, source-kind-aware superset of the existing `copyOverrides` option; `copyOverrides` continues to work unchanged and is still the right choice for simple global function overrides. The precedence chain is: kind-specific transform, then wildcard transform, then `copyOverrides`, then the built-in default.
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
