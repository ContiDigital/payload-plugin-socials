import { describe, expect, it } from 'vitest'

import { parseAccessResponse, resolveSocialsEndpointBase } from '../accessModel.js'

describe('parseAccessResponse', () => {
  it('reads strict booleans from an ok response', () => {
    expect(parseAccessResponse(true, { admin: true, publisher: true })).toEqual({
      admin: true,
      publisher: true,
    })
    expect(parseAccessResponse(true, { admin: false, publisher: true })).toEqual({
      admin: false,
      publisher: true,
    })
  })

  it('fails closed on a non-ok response', () => {
    expect(parseAccessResponse(false, { admin: true, publisher: true })).toEqual({
      admin: false,
      publisher: false,
    })
  })

  it('fails closed on a missing or non-object body', () => {
    expect(parseAccessResponse(true, undefined)).toEqual({ admin: false, publisher: false })
    expect(parseAccessResponse(true, null)).toEqual({ admin: false, publisher: false })
    expect(parseAccessResponse(true, 'nope')).toEqual({ admin: false, publisher: false })
  })

  it('treats non-boolean-true fields as false', () => {
    expect(parseAccessResponse(true, { admin: 'yes', publisher: 1 })).toEqual({
      admin: false,
      publisher: false,
    })
  })
})

describe('resolveSocialsEndpointBase', () => {
  it('joins the api route and configured base path', () => {
    const config = {
      admin: { custom: { socials: { apiBasePath: '/socials' } } },
      routes: { api: '/api' },
    }
    expect(resolveSocialsEndpointBase(config)).toBe('/api/socials')
  })

  it('honors a custom api route and base path', () => {
    const config = {
      admin: { custom: { socials: { apiBasePath: '/marketing' } } },
      routes: { api: '/custom-api/' },
    }
    expect(resolveSocialsEndpointBase(config)).toBe('/custom-api/marketing')
  })

  it('falls back to /api and /socials when config is empty or malformed', () => {
    expect(resolveSocialsEndpointBase(undefined)).toBe('/api/socials')
    expect(resolveSocialsEndpointBase({})).toBe('/api/socials')
    expect(resolveSocialsEndpointBase({ admin: {}, routes: {} })).toBe('/api/socials')
  })
})
