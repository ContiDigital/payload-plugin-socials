import type { Payload } from 'payload'

import type { PlatformId } from '../../types/index.js'

import { PLATFORM_IMAGE_CONSTRAINTS, resolveTargetDimensions } from './imagePreflight.js'
import { transformImage } from './transformImage.js'

/**
 * Per-platform asset options that the plugin host may supply.
 *
 * - `preflight`: when false (default) the helper returns the original URL
 *   immediately with no IO.
 * - `autoConvert`: when true the helper fetches the original, re-encodes it
 *   via sharp, uploads the result into Payload's media collection (named by
 *   `uploadCollection`, default `"media"`), and returns the new URL. Only
 *   triggered when `preflight` is true AND the image's declared format is
 *   disallowed by the target platform.
 * - `uploadCollection`: Payload upload-collection slug to store converted
 *   renditions. Default `"media"`.
 *
 * NOTE: This is intentionally a flat options bag, not part of
 * `NormalizedPluginOptions`, so the feature can be passed in at the call-site
 * without requiring a schema migration or options re-shape. Hosts that have
 * not opted in simply do not pass it.
 */
export type PlatformImageOptions = {
  autoConvert?: boolean
  preflight?: boolean
  uploadCollection?: string
}

export type ResolvePlatformImageArgs = {
  /** The image format already known from the source asset (e.g. 'png', 'webp'). */
  declaredFormat?: string
  /** Original source URL, as stored in the `social-posts` idempotency row. */
  imageUrl: string
  options: PlatformImageOptions
  payload: Payload
  platform: PlatformId
}

export type ResolvePlatformImageResult = {
  /** True when the image was fetched, re-encoded, and re-uploaded. */
  converted: boolean
  /** URL to use in the outbound platform API request body. */
  url: string
}

const normalizeFormat = (format: string | undefined): string | undefined => {
  if (!format) {
    return undefined
  }
  const lower = format
    .trim()
    .toLowerCase()
    .replace(/^image\//, '')
  return lower === 'jpg' ? 'jpeg' : lower
}

/**
 * Resolve the image URL to send in the outbound platform API request body.
 *
 * **Ordering contract (critical):**
 * The caller MUST derive the idempotency key and `primaryAssetUrl` from the
 * ORIGINAL `imageUrl` BEFORE calling this function. The result of this
 * function is used ONLY for the outbound body's image field and MUST NEVER
 * influence the key, `primaryAssetUrl`, or `sourceHash`.
 *
 * Behaviour:
 * - `options.preflight !== true`  → passthrough (no IO).
 * - Format is allowed by the platform  → passthrough.
 * - Format is disallowed AND `options.autoConvert !== true`  → throws a
 *   descriptive `Error` so the caller surfaces the problem to the operator.
 * - Format is disallowed AND `options.autoConvert === true`  → fetches the
 *   original, re-encodes it with sharp into the platform's preferred output
 *   format (jpeg for instagram/facebook, jpeg for pinterest), uploads the
 *   result via `payload.create`, and returns the new URL.
 * - Unknown / undefined declared format  → passthrough (cannot determine
 *   whether conversion is needed without probing the bytes).
 */
export const resolvePlatformImageUrl = async (
  args: ResolvePlatformImageArgs,
): Promise<ResolvePlatformImageResult> => {
  const { declaredFormat, imageUrl, options, payload, platform } = args

  // Preflight gate: when disabled (the default) pass through immediately.
  if (!options.preflight) {
    return { converted: false, url: imageUrl }
  }

  const normalized = normalizeFormat(declaredFormat)

  // Unknown format: we cannot make a safe decision without fetching the
  // bytes to probe; return the original and let the platform reject if needed.
  if (!normalized) {
    return { converted: false, url: imageUrl }
  }

  const constraints = PLATFORM_IMAGE_CONSTRAINTS[platform]
  const isAllowed = (constraints.formats as readonly string[]).includes(normalized)

  if (isAllowed) {
    return { converted: false, url: imageUrl }
  }

  // Format is not allowed for this platform.
  if (!options.autoConvert) {
    throw new Error(
      `Image format "${normalized}" is not accepted by ${platform} ` +
        `(allowed: ${constraints.formats.join(', ')}). ` +
        `Enable assets.autoConvert to automatically re-encode images.`,
    )
  }

  // --- Auto-convert path ---
  // Fetch the original image bytes.
  const fetchResponse = await fetch(imageUrl)
  if (!fetchResponse.ok) {
    throw new Error(
      `resolvePlatformImageUrl: failed to fetch original image (${fetchResponse.status}): ${imageUrl}`,
    )
  }
  const arrayBuffer = await fetchResponse.arrayBuffer()
  const inputBuffer = Buffer.from(arrayBuffer)

  // Determine the output format: prefer jpeg as the universally accepted
  // format; pinterest also accepts png and webp but jpeg is safest default.
  const outputFormat = (constraints.formats as readonly string[]).includes('jpeg')
    ? 'jpeg'
    : constraints.formats[0]

  // Resolve target dimensions based on the source metadata. We do not probe
  // the buffer here (that would require sharp for metadata) so we use the
  // platform's recommended dimensions as the safe default target.
  const recommended = constraints.recommended
  const targetDimensions = resolveTargetDimensions(platform, {
    height: recommended.height,
    width: recommended.width,
  })

  const converted = await transformImage(inputBuffer, {
    ...targetDimensions,
    format: outputFormat as 'jpeg' | 'png' | 'webp',
  })

  // Upload the converted rendition into Payload's media collection.
  const collection = (options.uploadCollection ?? 'media') as never
  const ext = outputFormat === 'jpeg' ? 'jpg' : outputFormat
  // Derive a stable filename from the original URL so repeated conversions
  // of the same source overwrite rather than accumulate.
  const originalName = imageUrl.split('/').pop()?.split('?')[0] ?? 'image'
  const baseName = originalName.replace(/\.[^.]+$/, '')
  const filename = `${baseName}-${platform}.${ext}`

  // Build the file upload object. Note: some Payload upload adapters expect
  // `name` to sort before `mimetype` in the object literal (linter enforces
  // perfectionist/sort-objects with `name` in the "top" group).
  const fileUpload = {
    name: filename,
    data: converted,
    mimetype: `image/${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`,
    size: converted.length,
  }

  const doc = (await payload.create({
    collection,
    data: {
      alt: `${platform} converted rendition of ${originalName}`,
    } as never,
    file: fileUpload,
    overrideAccess: true,
  })) as unknown as { url?: string }

  const uploadedUrl = doc.url
  if (!uploadedUrl) {
    throw new Error(`resolvePlatformImageUrl: payload.create for converted image returned no url`)
  }

  return { converted: true, url: uploadedUrl }
}
