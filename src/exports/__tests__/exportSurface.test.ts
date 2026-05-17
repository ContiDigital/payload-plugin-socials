import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Export-surface audit. A published Payload plugin must keep its client and
 * server (rsc) bundles cleanly split: every component re-exported from
 * `exports/client.js` must carry the `'use client'` directive, and every
 * component re-exported from `exports/rsc.js` must NOT. A wrong split breaks
 * the host's admin import map at runtime, which no type check or normal unit
 * test catches. This reads the source files rather than importing the React
 * components, so it runs cleanly in a node test environment.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const BARREL_RE = /export\s*\{([^{}]+)\}\s*from\s*'\.\.\/components\/(\w+)\.js'/g

type BarrelEntry = { componentRel: string; names: string[] }

const parseBarrel = (barrelRel: string): BarrelEntry[] => {
  const src = read(barrelRel)
  const entries: BarrelEntry[] = []
  for (const match of src.matchAll(BARREL_RE)) {
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
    entries.push({ componentRel: `src/components/${match[2]}.tsx`, names })
  }
  return entries
}

const firstCodeLine = (src: string): string => {
  for (const line of src.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return ''
}

const isUseClient = (line: string): boolean => line === `'use client'` || line === `"use client"`

const clientBarrel = parseBarrel('src/exports/client.ts')
const rscBarrel = parseBarrel('src/exports/rsc.ts')
const clientNames = new Set(clientBarrel.flatMap((e) => e.names))
const rscNames = new Set(rscBarrel.flatMap((e) => e.names))

const tsSources = (dir: string): string[] =>
  readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f}`)

describe('export surface: client bundle', () => {
  it('every client-exported component declares "use client"', () => {
    expect(clientBarrel.length).toBeGreaterThan(0)
    for (const entry of clientBarrel) {
      expect(isUseClient(firstCodeLine(read(entry.componentRel)))).toBe(true)
    }
  })

  it('exposes the components the admin wiring references', () => {
    for (const name of ['SocialPublishPanelClient', 'SocialsDashboardWidget', 'SocialsNavLink']) {
      expect(clientNames.has(name)).toBe(true)
    }
  })
})

describe('export surface: rsc bundle', () => {
  it('no rsc-exported component declares "use client"', () => {
    expect(rscBarrel.length).toBeGreaterThan(0)
    for (const entry of rscBarrel) {
      expect(isUseClient(firstCodeLine(read(entry.componentRel)))).toBe(false)
    }
  })

  it('exposes the server admin view', () => {
    expect(rscNames.has('SocialsAdminView')).toBe(true)
  })
})

describe('export surface: admin import strings resolve to the right bundle', () => {
  it('every "/client#X" and "/rsc#X" reference is exported from that bundle', () => {
    const files = [...tsSources('src/plugin'), ...tsSources('src/collections')]
    const refs: Array<{ bundle: string; name: string }> = []
    for (const file of files) {
      for (const match of read(file).matchAll(/\/(client|rsc)#(\w+)/g)) {
        refs.push({ name: match[2], bundle: match[1] })
      }
    }
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const exported = ref.bundle === 'client' ? clientNames : rscNames
      expect(exported.has(ref.name), `${ref.name} must be exported from ${ref.bundle}`).toBe(true)
    }
  })
})
