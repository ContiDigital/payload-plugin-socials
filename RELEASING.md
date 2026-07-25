# Releasing

This is the owner runbook for a public release. Never publish from a dirty
working tree or from a commit that does not have the matching annotated
`vX.Y.Z` tag.

## 1. Preflight the release commit

Confirm the version and dated CHANGELOG entry are final, the release branch is
merged, and CI is green on the exact commit to be tagged. From a clean checkout
of that commit, run:

```bash
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile
pnpm release:check
pnpm test:e2e
npm pack --dry-run
```

Do not continue if any command fails or if the package file list contains
anything outside the declared `dist/`, `docs/`, LICENSE, README, CHANGELOG, and
SECURITY publish surface.

## 2. Record live canary evidence

Read-only authentication probes remain available through
`SOCIALS_LIVE_PLATFORM=pinterest|meta|gbp pnpm test:live`.

Full lifecycle canaries are an additional explicit opt-in. Use approved
production credentials, a public link prepared for the test, and a public image
that visibly contains the words “Automated release canary, removed
immediately.” Never use customer content.

```bash
SOCIALS_LIVE_CANARY=1 \
PINTEREST_ACCESS_TOKEN=... \
CANARY_PINTEREST_BOARD_ID=... \
SOCIALS_LIVE_CANARY_IMAGE_URL=https://... \
SOCIALS_LIVE_CANARY_LINK_URL=https://... \
pnpm test:live
```

For Facebook, replace the Pinterest variables with `META_ACCESS_TOKEN` and
`CANARY_FACEBOOK_PAGE_ID`. For Instagram, provide `META_ACCESS_TOKEN` and
`CANARY_INSTAGRAM_USER_ID`, and also set `SOCIALS_LIVE_ALLOW_IG=1`. Instagram
uses a Story because the API cannot delete published media; the Story remains
visible until it expires after 24 hours. Pinterest and Facebook canaries delete
their content and verify that it is gone even when an intermediate assertion
fails. Tests for platforms whose complete variable set is absent are skipped.

GBP remains a read-only probe until Google grants Basic API Access and the owner
approves a real verified location for a lifecycle canary.

Record the result before tagging:

| Date (UTC) | Platform | External ID | Public visibility checked by | Cleanup confirmed |
| ---------- | -------- | ----------- | ---------------------------- | ----------------- |
|            |          |             |                              |                   |

Public visibility must be checked from a logged-out or non-role account. This
is especially important for Meta, where Development mode content is role-only.

## 3. Tag and create the GitHub release

Create an annotated tag on the exact verified commit and push it explicitly:

```bash
git tag -a vX.Y.Z -m "payload-plugin-socials vX.Y.Z"
git push origin vX.Y.Z
```

Create the GitHub release from that tag and use the matching CHANGELOG section
as its notes. Publishing the GitHub release triggers `.github/workflows/release.yml`,
which re-runs the full release and browser gates before npm trusted publishing.

## 4. One-time npm bootstrap (owner action)

The package name must exist before npm permits trusted-publisher configuration.
For the first publication only:

1. Make the GitHub repository public.
2. Create a narrowly scoped npm granular access token for this package, require
   2FA on the npm account, and authenticate from a clean owner workstation.
3. Check out the annotated release tag, re-run the preflight, and run
   `npm publish --access public`.
4. Remove the local npm token immediately.
5. In npm, configure the trusted publisher for organization `ContiDigital`,
   repository `payload-plugin-socials`, workflow `release.yml`, and GitHub
   environment `npm`.
6. Delete the bootstrap token. It must not be retained as a repository secret.

The bootstrap is an owner action, not a CI path. After it is complete, all
subsequent versions are published only by creating a GitHub release from the
matching annotated tag; npm exchanges the workflow's OIDC identity and attaches
provenance automatically.
