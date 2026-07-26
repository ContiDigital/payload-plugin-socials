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

| Date (UTC) | Platform | External ID                         | Public visibility checked by                      | Cleanup confirmed                        |
| ---------- | -------- | ----------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| 2026-07-25 | Facebook | `2313737801971147_1462338662597809` | Owner, from a non-role account (app in Live mode) | N/A: production post, retained by design |

Public visibility must be checked from a logged-out or non-role account. This
is especially important for Meta, where Development mode content is role-only.

## 3. One-time npm bootstrap (owner action)

Skip this section once the package exists on npm.

npm requires an existing package before its trusted publisher can be
configured. Do not consume the real release version during bootstrap. Instead,
from a temporary detached worktree at the verified release commit:

1. Make the GitHub repository public.
2. Change the temporary worktree version to `0.0.0-bootstrap.0`, update its
   lockfile, commit that version-only change, and create the annotated tag
   `v0.0.0-bootstrap.0`. Do not merge the bootstrap commit into `main`.
3. Run the complete preflight from that clean, tagged bootstrap commit.
4. Create a narrowly scoped npm granular access token, require 2FA on the npm
   account, authenticate from the owner workstation, and run
   `npm publish --access public --tag bootstrap`.
5. Push the bootstrap tag so the published artifact has durable source
   provenance.
6. In npm, configure the trusted publisher for organization `ContiDigital`,
   repository `payload-plugin-socials`, workflow `release.yml`, and GitHub
   environment `npm`.
7. Remove the local credential and delete the bootstrap token. It must not be
   retained as a repository secret.

The non-`latest` `bootstrap` dist-tag reserves the package without consuming
`0.9.3`. Return to the unchanged release commit before continuing. The
bootstrap commit is preserved only by its tag; the release branch and package
version stay `0.9.3`.

## 4. Backfill tags, tag the release, and create the GitHub release

The repository has annotated historical tags for the prior public releases.
After this hardening PR merges, push them once and verify their targets:

```bash
git rev-list -n 1 v0.9.1 # 57a7e36ff38c1e400fafe3128e1d3ce22d9e1331
git rev-list -n 1 v0.9.2 # 3b6d5170d39659ba3181a9b8c8199d7e47fb61f3
git push origin v0.9.1 v0.9.2
```

Create an annotated tag on the exact verified commit and push it explicitly:

```bash
git tag -a vX.Y.Z -m "payload-plugin-socials vX.Y.Z"
git push origin vX.Y.Z
```

Create the GitHub release from that tag and use the matching CHANGELOG section
as its notes. Publishing the GitHub release triggers `.github/workflows/release.yml`,
which re-runs the full release and browser gates before npm trusted publishing.

The bootstrap is an owner action, not a CI path. After it is complete, every
real version is published only by creating a GitHub release from the matching
annotated tag; npm exchanges the workflow's OIDC identity and attaches
provenance automatically.
