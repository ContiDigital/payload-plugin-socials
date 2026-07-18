import { beforeEach, describe, expect, it, vi } from 'vitest'

// We mock sharp entirely to avoid requiring the sharp binary and to test
// the branching logic in transformImage (which format method is called, with
// or without quality).

const toBufferFn = vi.fn().mockResolvedValue(Buffer.from('output'))
const jpegFn = vi.fn().mockReturnValue({ toBuffer: toBufferFn })
const pngFn = vi.fn().mockReturnValue({ toBuffer: toBufferFn })
const webpFn = vi.fn().mockReturnValue({ toBuffer: toBufferFn })
const resizeFn = vi.fn().mockReturnValue({
  jpeg: jpegFn,
  png: pngFn,
  toBuffer: toBufferFn,
  webp: webpFn,
})
const sharpMock = vi.fn().mockReturnValue({ resize: resizeFn })

vi.mock('sharp', () => ({ default: sharpMock }))

const { transformImage } = await import('../transformImage.js')

describe('transformImage — format branch coverage', () => {
  const input = Buffer.from('test-image-data')

  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default return values after clearAllMocks
    toBufferFn.mockResolvedValue(Buffer.from('output'))
    jpegFn.mockReturnValue({ toBuffer: toBufferFn })
    pngFn.mockReturnValue({ toBuffer: toBufferFn })
    webpFn.mockReturnValue({ toBuffer: toBufferFn })
    resizeFn.mockReturnValue({
      jpeg: jpegFn,
      png: pngFn,
      toBuffer: toBufferFn,
      webp: webpFn,
    })
    sharpMock.mockReturnValue({ resize: resizeFn })
  })

  it('encodes as jpeg with quality when format is jpeg and quality is set', async () => {
    await transformImage(input, {
      fit: 'cover',
      format: 'jpeg',
      height: 100,
      quality: 75,
      width: 100,
    })
    expect(resizeFn).toHaveBeenCalledWith(
      expect.objectContaining({ fit: 'cover', height: 100, width: 100 }),
    )
    expect(jpegFn).toHaveBeenCalledWith({ quality: 75 })
    expect(pngFn).not.toHaveBeenCalled()
    expect(webpFn).not.toHaveBeenCalled()
  })

  it('encodes as jpeg without quality when format is jpeg and quality is undefined', async () => {
    await transformImage(input, { fit: 'cover', format: 'jpeg', height: 50, width: 50 })
    expect(jpegFn).toHaveBeenCalledWith()
    expect(pngFn).not.toHaveBeenCalled()
    expect(webpFn).not.toHaveBeenCalled()
  })

  it('encodes as png when format is png (ignoring quality)', async () => {
    await transformImage(input, {
      fit: 'inside',
      format: 'png',
      height: 200,
      quality: 90,
      width: 200,
    })
    expect(pngFn).toHaveBeenCalledWith()
    expect(jpegFn).not.toHaveBeenCalled()
    expect(webpFn).not.toHaveBeenCalled()
  })

  it('encodes as webp with quality when format is webp and quality is set', async () => {
    await transformImage(input, {
      fit: 'cover',
      format: 'webp',
      height: 300,
      quality: 80,
      width: 300,
    })
    expect(webpFn).toHaveBeenCalledWith({ quality: 80 })
    expect(jpegFn).not.toHaveBeenCalled()
    expect(pngFn).not.toHaveBeenCalled()
  })

  it('encodes as webp without quality when format is webp and quality is undefined', async () => {
    await transformImage(input, { fit: 'inside', format: 'webp', height: 150, width: 150 })
    expect(webpFn).toHaveBeenCalledWith()
    expect(jpegFn).not.toHaveBeenCalled()
    expect(pngFn).not.toHaveBeenCalled()
  })

  it('does not call any format method when format is undefined (keeps source encoding)', async () => {
    await transformImage(input, { fit: 'inside', height: 100, width: 100 })
    expect(jpegFn).not.toHaveBeenCalled()
    expect(pngFn).not.toHaveBeenCalled()
    expect(webpFn).not.toHaveBeenCalled()
    expect(toBufferFn).toHaveBeenCalled()
  })

  it('passes the correct resize options including position: attention', async () => {
    await transformImage(input, {
      fit: 'cover',
      format: 'jpeg',
      height: 400,
      quality: 60,
      width: 600,
    })
    expect(resizeFn).toHaveBeenCalledWith({
      fit: 'cover',
      height: 400,
      position: 'attention',
      width: 600,
    })
  })
})
