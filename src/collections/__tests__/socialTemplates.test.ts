import type { CollectionBeforeChangeHook, PayloadRequest } from 'payload'

import { describe, expect, it, vi } from 'vitest'

import type { NormalizedPluginOptions } from '../../types/index.js'

import {
  buildSingleDefaultHook,
  buildSourceKindOptions,
  SKIP_SINGLE_DEFAULT_CONTEXT_KEY,
} from '../socialTemplates.js'

type InjectInto = NormalizedPluginOptions['admin']['injectInto']

const runHook = (
  hook: CollectionBeforeChangeHook,
  args: {
    context?: Record<string, unknown>
    data: Record<string, unknown>
    originalDoc?: Record<string, unknown>
    update: ReturnType<typeof vi.fn>
  },
) =>
  hook({
    collection: {} as never,
    context: (args.context ?? {}) as never,
    data: args.data as never,
    operation: 'update',
    originalDoc: args.originalDoc as never,
    req: { payload: { update: args.update } } as unknown as PayloadRequest,
  })

// ---------------------------------------------------------------------------
// buildSourceKindOptions
// ---------------------------------------------------------------------------

describe('buildSourceKindOptions', () => {
  it('derives one option per registered source kind', () => {
    expect(buildSourceKindOptions(['product', 'project'], [])).toEqual([
      { label: 'product', value: 'product' },
      { label: 'project', value: 'project' },
    ])
  })

  it('prefers the injectInto label for a kind when present', () => {
    const injectInto: InjectInto = [
      { collection: 'products', label: 'Products', sourceKind: 'product' },
      { collection: 'projects', sourceKind: 'project' },
    ]
    expect(buildSourceKindOptions(['product', 'project'], injectInto)).toEqual([
      { label: 'Products', value: 'product' },
      { label: 'project', value: 'project' },
    ])
  })

  it('returns an empty list when no kinds are registered', () => {
    expect(buildSourceKindOptions([], [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildSingleDefaultHook
// ---------------------------------------------------------------------------

describe('buildSingleDefaultHook', () => {
  it('does nothing when isDefault is not being set to true', async () => {
    const update = vi.fn()
    const hook = buildSingleDefaultHook()
    const data = { isDefault: false, sourceKind: 'product' }
    await runHook(hook, { data, update })
    expect(update).not.toHaveBeenCalled()
  })

  it('clears isDefault on sibling templates of the same kind, excluding the current row', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const hook = buildSingleDefaultHook()
    const data = { isDefault: true, sourceKind: 'product' }
    const result = await runHook(hook, { data, originalDoc: { id: 'tpl_1' }, update })
    expect(result).toBe(data)
    expect(update).toHaveBeenCalledTimes(1)
    const call = update.mock.calls[0][0]
    expect(call.where).toEqual({
      and: [
        { sourceKind: { equals: 'product' } },
        { isDefault: { equals: true } },
        { id: { not_equals: 'tpl_1' } },
      ],
    })
    expect(call.data).toEqual({ isDefault: false })
    expect(call.overrideAccess).toBe(true)
    expect(call.context).toEqual({ [SKIP_SINGLE_DEFAULT_CONTEXT_KEY]: true })
  })

  it('falls back to originalDoc.sourceKind when data omits it', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const hook = buildSingleDefaultHook()
    await runHook(hook, {
      data: { isDefault: true },
      originalDoc: { id: 'tpl_2', sourceKind: 'project' },
      update,
    })
    expect(update.mock.calls[0][0].where.and[0]).toEqual({ sourceKind: { equals: 'project' } })
  })

  it('omits the id filter on create (no originalDoc id yet)', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const hook = buildSingleDefaultHook()
    await runHook(hook, { data: { isDefault: true, sourceKind: 'product' }, update })
    expect(update.mock.calls[0][0].where.and).toEqual([
      { sourceKind: { equals: 'product' } },
      { isDefault: { equals: true } },
    ])
  })

  it('is loop-safe: skips when the cascade context flag is set', async () => {
    const update = vi.fn()
    const hook = buildSingleDefaultHook()
    await runHook(hook, {
      context: { [SKIP_SINGLE_DEFAULT_CONTEXT_KEY]: true },
      data: { isDefault: true, sourceKind: 'product' },
      update,
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('does nothing when no source kind can be resolved', async () => {
    const update = vi.fn()
    const hook = buildSingleDefaultHook()
    await runHook(hook, { data: { isDefault: true }, update })
    expect(update).not.toHaveBeenCalled()
  })
})
