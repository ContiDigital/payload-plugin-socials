import { createHash } from 'node:crypto'

/**
 * Hex-encoded SHA-256 of a string.
 *
 * This is the single source of truth for the plugin's content fingerprints and
 * idempotency keys (per-platform `idempotencyKey` derivation, the `sourceHash`
 * audit fingerprint, and the standalone-composer content id). Keeping one
 * implementation guarantees those hashes stay byte-for-byte stable, which the
 * `social-posts` idempotency invariant depends on (CLAUDE.md §2.18).
 */
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')
