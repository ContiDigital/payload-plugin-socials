import type { Field } from 'payload'

import { describe, expect, it } from 'vitest'

import { buildSocialPostsCollection } from '../socialPosts.js'

const named = (fields: Field[], name: string): Field | undefined =>
  fields.find((field) => 'name' in field && field.name === name)

/** Paths of every field named `id` below the top level, which SQL adapters silently skip. */
const nestedIdPaths = (fields: Field[], prefix = ''): string[] =>
  fields.flatMap((field) => {
    if (!('name' in field)) {
      return 'fields' in field ? nestedIdPaths(field.fields, prefix) : []
    }
    const path = prefix ? `${prefix}.${field.name}` : field.name
    const own = prefix && field.name === 'id' ? [path] : []
    return 'fields' in field ? [...own, ...nestedIdPaths(field.fields, path)] : own
  })

describe('social-posts schema', () => {
  const { fields } = buildSocialPostsCollection()

  it('stores the destination account in an indexed top-level field', () => {
    expect(named(fields, 'destinationId')).toMatchObject({
      type: 'text',
      index: true,
    })
  })

  it('declares no nested field named id', () => {
    expect(nestedIdPaths(fields)).toEqual([])
  })

  it('keeps the destination label and details in the group', () => {
    const group = named(fields, 'destination')
    expect(
      group && 'fields' in group ? group.fields.map((field) => 'name' in field && field.name) : [],
    ).toEqual(['label', 'meta'])
  })
})
