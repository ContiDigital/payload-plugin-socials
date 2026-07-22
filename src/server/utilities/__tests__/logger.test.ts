import type { Payload } from 'payload'

import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { createPluginLogger, logAsyncOperationFailure } from '../logger.js'

const mockLogger = () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
})

const asPayloadLogger = (l: unknown): Payload['logger'] => l as Payload['logger']

const realPino = () => {
  const lines: string[] = []
  const logger = pino(
    { level: 'debug', timestamp: false },
    { write: (line: string) => lines.push(line) },
  )
  return { lines, logger: asPayloadLogger(logger) }
}

describe('createPluginLogger', () => {
  it('returns safe no-ops when no payload logger is supplied', () => {
    const log = createPluginLogger(null)
    expect(() => log.info('hi')).not.toThrow()
    expect(log.error('boom')).toBeUndefined()
  })

  it('prefixes the message and forwards it to the matching level', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger)).info('hello world')
    expect(logger.info).toHaveBeenCalledWith('[Socials] hello world')
  })

  it('preserves the host logger as the method receiver', () => {
    const calls: unknown[][] = []
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info(this: unknown, ...args: unknown[]) {
        expect(this).toBe(logger)
        calls.push(args)
      },
      warn: vi.fn(),
    }

    createPluginLogger(asPayloadLogger(logger)).info('receiver check', { safe: true })

    expect(calls).toEqual([[{ safe: true }, '[Socials] receiver check']])
  })

  it('works with real Pino and emits prefixed, redacted structured output', () => {
    const { lines, logger } = realPino()

    expect(() =>
      createPluginLogger(logger, { operation: 'pino-regression' }).info('connected', {
        accessToken: 'pina_SECRET',
        boardCount: 4,
      }),
    ).not.toThrow()

    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(entry.msg).toBe('[Socials] connected')
    expect(entry.operation).toBe('pino-regression')
    expect(entry.boardCount).toBe(4)
    expect(entry.accessToken).toBe('[REDACTED]')
    expect(lines[0]).not.toContain('pina_SECRET')
  })

  it('swallows host logging failures', () => {
    const logger = asPayloadLogger({
      debug: vi.fn(),
      error: vi.fn(),
      info: () => {
        throw new Error('logging backend unavailable')
      },
      warn: vi.fn(),
    })

    expect(() => createPluginLogger(logger).info('business operation succeeded')).not.toThrow()
  })

  it('merges context and meta and passes them as the first pino argument', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger), { op: 'publish' }).warn('careful', { postId: 7 })
    expect(logger.warn).toHaveBeenCalledWith({ op: 'publish', postId: 7 }, '[Socials] careful')
  })

  it('redacts secret keys case-insensitively, including nested values', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger)).info('connecting', {
      Access_Token: 'pina_secret',
      nested: { client_secret: 'shh', safe: 1 },
      userId: 42,
    })
    const [meta] = logger.info.mock.calls[0]
    expect(meta.Access_Token).toBe('[REDACTED]')
    expect(meta.nested.client_secret).toBe('[REDACTED]')
    expect(meta.nested.safe).toBe(1)
    expect(meta.userId).toBe(42)
  })

  it('redacts secrets inside arrays', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger)).info('batch', {
      items: [{ password: 'p' }, { ok: true }],
    })
    const [meta] = logger.info.mock.calls[0]
    expect(meta.items[0].password).toBe('[REDACTED]')
    expect(meta.items[1].ok).toBe(true)
  })

  it('redacts prefixed secret variants via the suffix rule', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger)).info('tokens', {
      clientSecret: 'shh',
      pageAccessToken: 'EAA',
      pinAccessToken: 'pina_x',
      saPrivateKey: '-----',
      systemUserAccessToken: 'sys_x',
      userPassword: 'pw',
      'x-api-key': 'k',
    })
    const [meta] = logger.info.mock.calls[0]
    for (const key of [
      'clientSecret',
      'pageAccessToken',
      'pinAccessToken',
      'saPrivateKey',
      'systemUserAccessToken',
      'userPassword',
      'x-api-key',
    ]) {
      expect(meta[key]).toBe('[REDACTED]')
    }
  })

  it('preserves safe keys that merely resemble secret names', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger)).info('safe', {
      idempotencyKey: 'abc123',
      sortKey: 'createdAt',
      tokenCount: 5,
    })
    const [meta] = logger.info.mock.calls[0]
    expect(meta.idempotencyKey).toBe('abc123')
    expect(meta.sortKey).toBe('createdAt')
    expect(meta.tokenCount).toBe(5)
  })

  it('redacts credentials embedded inside string values and messages', () => {
    const logger = mockLogger()
    createPluginLogger(asPayloadLogger(logger)).error(
      'request failed Authorization: Bearer EAA-secret-token',
      {
        cookie: 'session=secret',
        diagnostic: 'encryption_key=abc123',
        response: '{"access_token":"pina_secret","ok":false}',
        url: 'https://example.com/cb?client_secret=shh&code=ok',
      },
    )
    const [meta, message] = logger.error.mock.calls[0]
    expect(message).not.toContain('EAA-secret-token')
    expect(meta.cookie).toBe('[REDACTED]')
    expect(meta.diagnostic).not.toContain('abc123')
    expect(meta.response).not.toContain('pina_secret')
    expect(meta.url).not.toContain('client_secret=shh')
  })

  it('truncates objects nested beyond the depth cap', () => {
    const logger = mockLogger()
    let deep: Record<string, unknown> = { leaf: 'value' }
    for (let i = 0; i < 12; i += 1) {
      deep = { child: deep }
    }
    createPluginLogger(asPayloadLogger(logger)).info('deep', deep)
    const [meta] = logger.info.mock.calls[0]
    expect(JSON.stringify(meta)).toContain('[truncated]')
  })

  it('does not throw when a level method is missing', () => {
    const partial = asPayloadLogger({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() })
    expect(() => createPluginLogger(partial).info('no info method')).not.toThrow()
  })
})

describe('logAsyncOperationFailure', () => {
  it('logs an Error message without throwing', () => {
    const logger = mockLogger()
    const payload = { logger: asPayloadLogger(logger) } as unknown as Payload
    logAsyncOperationFailure(payload, 'sweep', new Error('kaboom'))
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [meta] = logger.error.mock.calls[0]
    expect(meta.error).toBe('kaboom')
    expect(meta.operation).toBe('sweep')
  })

  it('never throws when the host logger throws', () => {
    const payload = {
      logger: asPayloadLogger({
        error: () => {
          throw new Error('logging backend unavailable')
        },
      }),
    } as unknown as Payload

    expect(() => logAsyncOperationFailure(payload, 'sweep', new Error('kaboom'))).not.toThrow()
  })

  it('is safe when payload is null', () => {
    expect(() => logAsyncOperationFailure(null, 'sweep', 'string error')).not.toThrow()
  })
})
