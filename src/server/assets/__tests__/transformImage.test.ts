import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { transformImage } from '../transformImage.js'

const makeImage = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: {
      background: { b: 30, g: 30, r: 200 },
      channels: 3,
      height,
      width,
    },
  })
    .png()
    .toBuffer()

describe('transformImage', () => {
  it('resizes to the target dimensions and re-encodes as jpeg', async () => {
    const input = await makeImage(100, 100)
    const output = await transformImage(input, {
      fit: 'cover',
      format: 'jpeg',
      height: 75,
      width: 50,
    })
    const meta = await sharp(output).metadata()
    expect(meta.width).toBe(50)
    expect(meta.height).toBe(75)
    expect(meta.format).toBe('jpeg')
  })

  it('downscales without upscaling when fit is inside', async () => {
    const input = await makeImage(1200, 1200)
    const output = await transformImage(input, { fit: 'inside', height: 600, width: 600 })
    const meta = await sharp(output).metadata()
    expect(meta.width).toBe(600)
    expect(meta.height).toBe(600)
  })
})
