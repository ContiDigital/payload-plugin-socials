import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions, PlatformId, PublishedRef } from '../../types/index.js'

import { PLATFORM_IDS, SOCIAL_POSTS_SLUG } from '../../constants.js'
import { INSTAGRAM_DELETE_UNSUPPORTED_MESSAGE } from '../platforms/instagram/adapter.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { assertAccess } from '../utilities/access.js'
import { NotFoundError, ValidationError } from '../utilities/errors.js'
import { errorResponse, getRouteParam, jsonResponse } from '../utilities/http.js'

/**
 * DELETE {basePath}/posts/:postId
 *
 * Two operation modes depending on row status:
 *
 * **Cancel mode (status = 'queued')**
 *   Cancels a queued post without calling any platform adapter (nothing has
 *   been published yet). Sets status to 'cancelled' and records
 *   meta.cancelledAt / meta.cancelledBy. Returns { ok, postId, status: 'cancelled' }.
 *   The cancelled row remains re-claimable for republish-in-place via
 *   reservePublication (which already includes 'cancelled' in RECLAIMABLE_STATUSES).
 *
 * **Soft-delete mode (status = 'published')**
 *   Two sub-modes:
 *
 *   Normal mode (default):
 *   1. Validates the row exists and is in `published` state with an externalId.
 *   2. For Instagram rows: returns HTTP 422 immediately with an actionable
 *      message — Meta's Graph API does not expose a delete endpoint for
 *      published IG Business media. The adapter is never called.
 *   3. For other platforms: calls the platform adapter's `delete` method.
 *      404 / "not found" from the upstream platform is treated as success
 *      (deletion is idempotent).
 *   4. Updates the row to status `deleted` and records `meta.deletedAt` and
 *      `meta.deletedBy`. Never hard-deletes the row.
 *
 *   localOnly mode (?localOnly=true):
 *   Skips all upstream platform calls entirely and soft-deletes the local row
 *   only. Sets `meta.deletedLocalOnly: true` to flag that the upstream post
 *   was not removed via the API (e.g. it was already deleted in the platform
 *   app). The same published + externalId guards apply. The resulting
 *   `deleted` row is re-claimable for republish-in-place, exactly like rows
 *   deleted via the normal path.
 *
 * Access: publisher scope.
 */
export const createPostDeleteEndpoints = (options: NormalizedPluginOptions): Endpoint[] => [
  {
    handler: async (req) => {
      try {
        await assertAccess(req, options, 'publisher')

        const postId = getRouteParam(req, 'postId')
        if (!postId) {
          throw new ValidationError('postId route parameter is required')
        }

        // Detect localOnly flag from query string.
        const localOnly =
          req.query &&
          typeof req.query === 'object' &&
          'localOnly' in req.query &&
          req.query.localOnly === 'true'

        // Load the social-posts row.
        let row: Record<string, unknown>
        try {
          row = (await req.payload.findByID({
            id: postId as never,
            collection: SOCIAL_POSTS_SLUG as never,
            depth: 0,
            overrideAccess: true,
          })) as unknown as Record<string, unknown>
        } catch {
          throw new NotFoundError(`social-posts/${postId} not found`)
        }

        if (!row || !row.id) {
          throw new NotFoundError(`social-posts/${postId} not found`)
        }

        const userId =
          req.user && typeof (req.user as { id?: number | string }).id !== 'undefined'
            ? (req.user as { id: number | string }).id
            : undefined

        const existingMeta =
          row.meta && typeof row.meta === 'object' ? (row.meta as Record<string, unknown>) : {}

        // ── Fix 4: Cancel path for queued rows ──────────────────────────────
        // A queued post has not yet been published. Cancelling it requires no
        // upstream API call — we simply transition the row to 'cancelled' and
        // stamp the cancellation metadata. The cancelled row stays re-claimable
        // for republish-in-place via reservePublication.
        if (row.status === 'queued') {
          const cancelledMeta: Record<string, unknown> = {
            ...existingMeta,
            cancelledAt: new Date().toISOString(),
            ...(userId !== undefined ? { cancelledBy: userId } : {}),
          }
          await req.payload.update({
            id: row.id as never,
            collection: SOCIAL_POSTS_SLUG as never,
            data: {
              meta: cancelledMeta,
              status: 'cancelled',
            } as never,
            overrideAccess: true,
          })
          return jsonResponse({ ok: true, postId: row.id, status: 'cancelled' })
        }

        // Only published rows (or queued, handled above) can be acted on via
        // this endpoint.
        if (row.status !== 'published') {
          throw new ValidationError(
            `Cannot delete a post with status "${String(row.status)}"; only published or queued posts may be deleted or cancelled`,
          )
        }
        if (!row.externalId) {
          throw new ValidationError(
            'Cannot delete a published post without an externalId (the post has no upstream reference)',
          )
        }

        const platform = row.platform as PlatformId
        if (!PLATFORM_IDS.includes(platform)) {
          throw new ValidationError(`Unknown platform "${String(platform)}"`)
        }

        // Build the publishedRef from the row fields.
        const publishedRef: PublishedRef = {
          externalId: row.externalId as string,
          externalUrl: typeof row.externalUrl === 'string' ? row.externalUrl : undefined,
          meta: existingMeta,
          platform,
        }

        if (!localOnly) {
          // Instagram: API deletion is not supported — return 422 without touching
          // the adapter or the local row.
          if (platform === 'instagram') {
            return jsonResponse({ error: INSTAGRAM_DELETE_UNSUPPORTED_MESSAGE, ok: false }, 422)
          }

          // Other platforms: call the adapter's delete method.
          // 404 / "not found" errors from upstream are treated as idempotent success.
          const adapter = getPlatformAdapter(platform)
          if (typeof adapter.delete === 'function') {
            try {
              await adapter.delete({ options, payload: req.payload, publishedRef, req })
            } catch (deleteError) {
              // If the upstream says the post is already gone (404 / "not found"),
              // treat it as success. Any other upstream error is fatal — we must NOT
              // mark the row deleted if the upstream deletion failed.
              const isAlreadyGone = isUpstreamNotFoundError(deleteError)
              if (!isAlreadyGone) {
                throw deleteError
              }
            }
          }
        }

        // Soft-delete: update the row to status 'deleted'. Record deletion
        // metadata in the existing meta json field.
        const updatedMeta: Record<string, unknown> = {
          ...existingMeta,
          deletedAt: new Date().toISOString(),
          ...(userId !== undefined ? { deletedBy: userId } : {}),
          ...(localOnly ? { deletedLocalOnly: true } : {}),
        }

        await req.payload.update({
          id: row.id as never,
          collection: SOCIAL_POSTS_SLUG as never,
          data: {
            meta: updatedMeta,
            status: 'deleted',
          } as never,
          overrideAccess: true,
        })

        return jsonResponse({ ok: true, postId: row.id, status: 'deleted' })
      } catch (error) {
        return errorResponse(req, error)
      }
    },
    method: 'delete',
    path: `${options.api.basePath}/posts/:postId`,
  },
]

/**
 * Returns true when the error indicates the upstream post is already gone
 * (HTTP 404 or a platform-specific "not found" error). This makes the
 * delete endpoint idempotent: calling DELETE on an already-deleted post
 * succeeds rather than surfacing a confusing upstream error.
 */
const isUpstreamNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }
  const err = error as Record<string, unknown>

  // PluginError / PlatformApiError carry statusCode.
  if (typeof err.statusCode === 'number' && err.statusCode === 404) {
    return true
  }
  // Check the message for common "not found" signals from platform APIs.
  if (typeof err.message === 'string') {
    const msg = err.message.toLowerCase()
    if (
      msg.includes('404') ||
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('pin not found') ||
      msg.includes('media not found') ||
      msg.includes('localpost') // GBP returns "requested entity was not found"
    ) {
      return true
    }
  }
  return false
}
