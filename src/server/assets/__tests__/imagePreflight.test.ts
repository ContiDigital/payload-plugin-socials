import { describe, expect, it } from 'vitest'

import type { PreflightIssue } from '../imagePreflight.js'

import {
  PLATFORM_IMAGE_CONSTRAINTS,
  preflightImage,
  resolveTargetDimensions,
} from '../imagePreflight.js'

const errors = (issues: PreflightIssue[]) => issues.filter((i) => i.severity === 'error')

describe('preflightImage — format + size', () => {
  it('passes a compliant Pinterest image', () => {
    const result = preflightImage('pinterest', {
      bytes: 2 * 1024 * 1024,
      format: 'jpeg',
      height: 1500,
      width: 1000,
    })
    expect(result.ok).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('flags an image below the platform minimum width as an error', () => {
    const result = preflightImage('pinterest', { height: 750, width: 500 })
    expect(result.ok).toBe(false)
    expect(errors(result.issues)[0].message).toMatch(/at least 600px/)
  })

  it('rejects a disallowed format', () => {
    const result = preflightImage('instagram', { format: 'png', height: 1350, width: 1080 })
    expect(result.ok).toBe(false)
    expect(errors(result.issues)[0].message).toMatch(/does not accept png/)
  })

  it('normalizes jpg and image/jpeg to jpeg', () => {
    expect(preflightImage('instagram', { format: 'jpg', height: 1350, width: 1080 }).ok).toBe(true)
    expect(
      preflightImage('instagram', { format: 'image/jpeg', height: 1350, width: 1080 }).ok,
    ).toBe(true)
  })

  it('errors when the file is over the platform byte limit', () => {
    const result = preflightImage('instagram', {
      bytes: 12 * 1024 * 1024,
      format: 'jpeg',
      height: 1350,
      width: 1080,
    })
    expect(result.ok).toBe(false)
    expect(errors(result.issues).some((i) => i.message.includes('MB'))).toBe(true)
  })

  it('errors when a GBP image is under the minimum size', () => {
    const result = preflightImage('gbp', { height: 200, width: 200 })
    expect(result.ok).toBe(false)
  })
})

describe('preflightImage — aspect warnings', () => {
  it('warns (but does not block) when the image is wider than the platform prefers', () => {
    const result = preflightImage('pinterest', { format: 'jpeg', height: 1000, width: 2000 })
    expect(result.ok).toBe(true)
    expect(result.issues.some((i) => i.severity === 'warning')).toBe(true)
  })

  it('warns when an Instagram image exceeds the max width', () => {
    const result = preflightImage('instagram', { format: 'jpeg', height: 2000, width: 2000 })
    expect(result.issues.some((i) => /downscaled/.test(i.message))).toBe(true)
  })
})

describe('resolveTargetDimensions', () => {
  it('leaves a within-band Pinterest image uncropped', () => {
    const spec = resolveTargetDimensions('pinterest', { height: 3000, width: 2000 })
    expect(spec.fit).toBe('inside')
    expect(spec.width).toBe(2000)
    expect(spec.height).toBe(3000)
  })

  it('crops a too-wide Pinterest image to the nearest aspect edge', () => {
    const spec = resolveTargetDimensions('pinterest', { height: 1000, width: 2000 })
    expect(spec.fit).toBe('cover')
    // maxAspect 1 -> square
    expect(spec.width).toBe(2000)
    expect(spec.height).toBe(2000)
  })

  it('upscales a narrow Pinterest image to the minimum width', () => {
    const spec = resolveTargetDimensions('pinterest', { height: 600, width: 400 })
    expect(spec.width).toBe(600)
    expect(spec.height).toBe(900)
    expect(spec.fit).toBe('inside')
  })

  it('clamps an Instagram image to the max width', () => {
    const spec = resolveTargetDimensions('instagram', { height: 2000, width: 2000 })
    expect(spec.width).toBe(1440)
    expect(spec.height).toBe(1440)
    expect(spec.fit).toBe('inside')
  })

  it('crops an over-tall Instagram image to the 4:5 floor', () => {
    const spec = resolveTargetDimensions('instagram', { height: 2000, width: 1000 })
    expect(spec.fit).toBe('cover')
    expect(spec.width).toBe(1000)
    expect(spec.height).toBe(1250)
  })
})

describe('PLATFORM_IMAGE_CONSTRAINTS', () => {
  it('covers all four platforms', () => {
    expect(Object.keys(PLATFORM_IMAGE_CONSTRAINTS).sort()).toEqual([
      'facebook',
      'gbp',
      'instagram',
      'pinterest',
    ])
  })
})
