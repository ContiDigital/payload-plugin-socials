#!/usr/bin/env bash
#
# Smoke-test the npm tarball: pack, install into a tmp dir, import the
# package as ESM, exercise the curried plugin factory, and verify that the
# bundler-only client entrypoints resolve to files in the packed artifact.
#
# Run via `pnpm pack:smoke` after `pnpm build`. Wired into `release:check`.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

rm -f ./*.tgz
pack_log="$(mktemp)"
npm pack >"$pack_log" 2>&1 || { cat "$pack_log"; exit 1; }
pack_file="$(realpath "$(ls -1t ./*.tgz | head -n 1)")"
mapfile -t peer_specs < <(
  node -e "const p=require('./package.json'); for (const name of Object.keys(p.peerDependencies ?? {})) console.log(name + '@' + (p.devDependencies?.[name] ?? p.peerDependencies[name]))"
)

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; rm -f "$pack_log" "$pack_file"; }
trap cleanup EXIT

cd "$tmp_dir"
npm init -y >/dev/null
npm install "$pack_file" "${peer_specs[@]}" >/dev/null
node --input-type=module -e "
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import plugin from 'payload-plugin-socials'
if (typeof plugin !== 'function') {
  throw new Error('default export is not a function: ' + typeof plugin)
}
const inner = plugin({
  disabled: true,
  encryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  authorize: async () => true,
  sources: { product: async () => ({ sourceId: '1', sourceKind: 'product', baseTitle: 't', baseDescription: 'd', link: '', images: [] }) },
  platforms: {}
})
if (typeof inner !== 'function') {
  throw new Error('curried inner is not a function: ' + typeof inner)
}
for (const specifier of ['payload-plugin-socials/client', 'payload-plugin-socials/rsc']) {
  await access(fileURLToPath(import.meta.resolve(specifier)))
}
"

echo "Pack smoke test passed."
