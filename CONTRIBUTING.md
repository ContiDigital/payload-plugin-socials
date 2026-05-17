# Contributing

Thanks for your interest in improving `payload-plugin-socials`. This guide
covers the local setup and the conventions the codebase follows.

## Setup

```bash
pnpm install
```

The repo ships a dev harness under `dev/` (a small Payload plus Next app). To
run the admin panel against the plugin source:

```bash
pnpm dev
```

The harness uses an in-process sqlite database, so you do not need a separate
database running.

## The verification gate

Before opening a pull request, run the full gate and make sure it is green:

```bash
pnpm exec tsc --noEmit   # strict type check
pnpm format:check        # Prettier, no drift
pnpm lint                # eslint, zero warnings allowed
pnpm test                # vitest unit and integration suite
pnpm build               # swc emit plus type declarations
pnpm pack:smoke          # packs the tarball and imports it in a clean dir
```

`pnpm release:check` runs all of these in sequence and is what CI enforces.

Read-only provider contract checks are opt-in because they require real approved
credentials. Set `SOCIALS_LIVE_PLATFORM` to `pinterest`, `meta`, or `gbp`, set
the matching `*_ACCESS_TOKEN`, and run `pnpm test:live`. These tests never
publish or delete external content and never print token values.

The dev harness enables Instagram and Facebook when `META_APP_ID` and
`META_APP_SECRET` are set, and enables GBP when `GBP_CLIENT_ID` and
`GBP_CLIENT_SECRET` are set. Copy `dev/.env.example` to `dev/.env`, use a public
HTTPS `PUBLIC_URL` for OAuth and provider media callbacks, then run `pnpm dev`.
A configured `META_SYSTEM_USER_TOKEN` takes precedence over interactive Meta
OAuth. Set a unique `DEV_ADMIN_PASSWORD` before exposing the harness through a
public HTTPS host, and use a fresh dev database so the seeded account receives
it. Before a real publish, set `SOCIALS_TEST_IMAGE_URL`,
`SOCIALS_TEST_LINK_URL`, and optionally `SOCIALS_TEST_VIDEO_URL` to public HTTPS
assets that the provider can fetch without cookies or request headers. Set
`SOCIALS_INTERNAL_API_KEY` when testing the scheduler and insights endpoints.
Never commit the populated environment file.

## Conventions

These are not negotiable, because they keep the published package consistent
and safe:

- **ESM only.** Relative imports use the `.js` extension even in `.ts` source
  (the package targets NodeNext).
- **Strict TypeScript.** `strict: true`, and no `as any`.
- **No `enum`.** Use `as const` arrays plus a derived union type.
- **Constants live in `src/constants.ts`.** Do not hard-code slugs, queue
  names, or default values elsewhere.
- **One types module.** Public and internal types are both exported from
  `src/types/index.ts`.
- **Never log secrets.** All logging goes through the plugin logger, which
  redacts secret-bearing keys. Do not call `console` or `payload.logger`
  directly.
- **Host-agnostic and AWS-agnostic.** No `@aws-sdk` imports, and nothing that
  assumes a specific deployment target.
- **Write tests for the logic you touch.** Adapters are unit-tested against a
  mocked `fetch`; pure logic is tested directly. A real Payload boot test
  guards the schema.
- **Documentation uses a plain human voice with no emdashes.**

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
`fix:`, `test:`, `docs:`, `chore:`, and so on). Keep each commit scoped to one
coherent change, and update `CHANGELOG.md` under `[Unreleased]` for any change
that affects consumers.

## API contracts

The four platform adapters are written against the published API contracts for
Pinterest v5, the Meta Graph API, and the Google Business Profile LocalPosts
API. When you change adapter behavior, confirm the current contract from the
official docs first and note any version-specific details in the change.
