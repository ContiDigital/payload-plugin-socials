import type { ImageFormat, TargetDimensions } from './imagePreflight.js'

/**
 * Execute a resolved crop/resize spec with sharp.
 *
 * sharp is an OPTIONAL peer dependency: only hosts that opt into server-side
 * asset processing need it installed. It is imported dynamically so the rest
 * of the plugin loads without sharp present. A `format` re-encodes the output;
 * omit it to keep the source encoding.
 */

export type TransformOutputFormat = Extract<ImageFormat, 'jpeg' | 'png' | 'webp'>

export type TransformSpec = {
  format?: TransformOutputFormat
  /** JPEG/WebP quality (1-100). Defaults to sharp's own default. */
  quality?: number
} & TargetDimensions

export const transformImage = async (input: Buffer, spec: TransformSpec): Promise<Buffer> => {
  const sharpModule = (await import('sharp')) as unknown as {
    default: (i: Buffer) => SharpLike
  }
  const sharp = sharpModule.default

  let pipeline = sharp(input).resize({
    fit: spec.fit,
    height: spec.height,
    position: 'attention',
    width: spec.width,
  })

  const quality = spec.quality
  if (spec.format === 'jpeg') {
    pipeline = quality ? pipeline.jpeg({ quality }) : pipeline.jpeg()
  } else if (spec.format === 'png') {
    pipeline = pipeline.png()
  } else if (spec.format === 'webp') {
    pipeline = quality ? pipeline.webp({ quality }) : pipeline.webp()
  }

  return pipeline.toBuffer()
}

type SharpLike = {
  jpeg: (opts?: { quality?: number }) => SharpLike
  png: () => SharpLike
  resize: (opts: {
    fit: 'cover' | 'inside'
    height: number
    position: string
    width: number
  }) => SharpLike
  toBuffer: () => Promise<Buffer>
  webp: (opts?: { quality?: number }) => SharpLike
}
