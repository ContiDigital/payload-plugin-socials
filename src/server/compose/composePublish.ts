import type { Payload, PayloadRequest } from 'payload'

import type {
  NormalizedPluginOptions,
  PlatformId,
  PublishedRef,
  SocialSourceContext,
  ValidationResult,
} from '../../types/index.js'

import { getPlatformAdapter } from '../platforms/registry.js'
import { queuePublicationReconciliation } from '../services/publicationReconciliation.js'
import {
  failPublicationReservation,
  reservePublication,
} from '../services/publicationReservation.js'
import { sha256Hex } from '../utilities/hash.js'
import { publicErrorMessage } from '../utilities/http.js'
import { buildPublicationIdentity } from '../utilities/publicationIdentity.js'

/**
 * Multi-channel publish orchestrator. Given one source context and a set of
 * per-platform inputs, validate and publish each target INDEPENDENTLY: one
 * channel failing (disabled, invalid input, upstream error) never blocks the
 * others. This is the server backbone of the standalone cross-channel
 * composer and of any "publish to all selected channels" action.
 */

export type ComposeTarget = {
  input: Record<string, unknown>
  platform: PlatformId
}

export type ComposeResultItem = {
  error?: string
  ok: boolean
  platform: PlatformId
  publishedRef?: PublishedRef
}

export type ComposeResult = {
  anyPublished: boolean
  results: ComposeResultItem[]
}

const publishOne = async (
  args: {
    ctx: SocialSourceContext
    options: NormalizedPluginOptions
    payload: Payload
    req?: PayloadRequest
  },
  target: ComposeTarget,
): Promise<ComposeResultItem> => {
  try {
    const adapter = getPlatformAdapter(target.platform, args.options)
    const validation = await adapter.validate({
      ctx: args.ctx,
      input: target.input,
      options: args.options,
    })
    if (!validation.ok) {
      const message = validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join('; ')
      return { error: message || 'Input is invalid', ok: false, platform: target.platform }
    }
    const identity = buildPublicationIdentity({
      ctx: args.ctx,
      input: target.input,
      platform: target.platform,
      sourceId: args.ctx.sourceId,
      sourceKind: args.ctx.sourceKind,
    })
    const reservation = await reservePublication({
      destinationId: identity.destinationId,
      idempotencyKey: identity.idempotencyKey,
      imageUrl: identity.primaryAssetUrl,
      payload: args.payload,
      platform: target.platform,
      sourceHash: sha256Hex(JSON.stringify({ input: target.input, platform: target.platform })),
      sourceId: args.ctx.sourceId,
      sourceKind: args.ctx.sourceKind,
      title: args.ctx.baseTitle,
    })
    let publishedRef = reservation.publishedRef
    if (!publishedRef) {
      try {
        publishedRef = await adapter.publish({
          ctx: args.ctx,
          input: target.input,
          options: args.options,
          payload: args.payload,
          postId: reservation.postId,
          req: args.req,
        })
      } catch (error) {
        await failPublicationReservation(args.payload, reservation, error)
        throw error
      }
    }
    await queuePublicationReconciliation({
      payload: args.payload,
      postId: reservation.postId,
      publishedRef,
      req: args.req,
    })
    return { ok: true, platform: target.platform, publishedRef }
  } catch (error) {
    return { error: publicErrorMessage(error), ok: false, platform: target.platform }
  }
}

export type ComposeValidationItem = {
  platform: PlatformId
  validation: ValidationResult
}

/**
 * Run each target's adapter validation against a standalone context without reserving or
 * publishing anything. A disabled or unknown platform is reported as an error issue for that
 * target, never as a thrown request failure.
 */
export const validateComposeTargets = async (args: {
  ctx: SocialSourceContext
  options: NormalizedPluginOptions
  targets: ComposeTarget[]
}): Promise<{ ok: boolean; results: ComposeValidationItem[] }> => {
  const results = await Promise.all(
    args.targets.map(async (target): Promise<ComposeValidationItem> => {
      try {
        const adapter = getPlatformAdapter(target.platform, args.options)
        const validation = await adapter.validate({
          ctx: args.ctx,
          input: target.input,
          options: args.options,
        })
        return { platform: target.platform, validation }
      } catch (error) {
        return {
          platform: target.platform,
          validation: {
            issues: [{ message: publicErrorMessage(error), severity: 'error' }],
            ok: false,
          },
        }
      }
    }),
  )
  return { ok: results.every((item) => item.validation.ok), results }
}

export const composeAndPublish = async (args: {
  ctx: SocialSourceContext
  options: NormalizedPluginOptions
  payload: Payload
  req?: PayloadRequest
  targets: ComposeTarget[]
}): Promise<ComposeResult> => {
  const results = await Promise.all(args.targets.map((target) => publishOne(args, target)))
  return { anyPublished: results.some((r) => r.ok), results }
}
