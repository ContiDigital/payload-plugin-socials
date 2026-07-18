import type { Endpoint } from 'payload'

import type { NormalizedPluginOptions, PlatformId, PublishedRef } from '../../types/index.js'

import { PLATFORM_IDS, SOCIAL_POSTS_SLUG } from '../../constants.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { assertAccess } from '../utilities/access.js'
import { NotFoundError, ValidationError } from '../utilities/errors.js'
import { errorResponse, getRouteParam, jsonResponse } from '../utilities/http.js'

/**
 * DELETE {basePath}/posts/:postId
 *
 * Soft-deletes a published social-posts row:
 *   1. Validates the row exists and is in `published` state with an externalId.
 *   2. Calls the platform adapter's `delete` method (404 / "not found" from the
 *      upstream platform is treated as success — deletion is idempotent).
 *   3. Updates the row to status `deleted` and records deletion metadata in
 *      `meta.deletedAt` and `meta.deletedBy`. Never hard-deletes the row.
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

        // Only published rows with an externalId can be deleted via this endpoint.
        if (row.status !== 'published') {
          throw new ValidationError(
            `Cannot delete a post with status "${String(row.status)}"; only published posts may be deleted`,
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
        const existingMeta =
          row.meta && typeof row.meta === 'object' ? (row.meta as Record<string, unknown>) : {}
        const publishedRef: PublishedRef = {
          externalId: row.externalId as string,
          externalUrl: typeof row.externalUrl === 'string' ? row.externalUrl : undefined,
          meta: existingMeta,
          platform,
        }

        // Call the platform adapter's delete method.
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

        // Soft-delete: update the row to status 'deleted'. Record deletion
        // metadata in the existing meta json field.
        const deletedByUserId =
          req.user && typeof (req.user as { id?: number | string }).id !== 'undefined'
            ? (req.user as { id: number | string }).id
            : undefined

        const updatedMeta: Record<string, unknown> = {
          ...existingMeta,
          deletedAt: new Date().toISOString(),
          ...(deletedByUserId !== undefined ? { deletedBy: deletedByUserId } : {}),
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
