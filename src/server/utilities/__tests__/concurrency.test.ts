import { describe, expect, it } from 'vitest'

import { createConcurrencyLimiter } from '../concurrency.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createConcurrencyLimiter', () => {
  it('runs at most the configured number of tasks at once, in submission order', async () => {
    const run = createConcurrencyLimiter(2)
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const started: number[] = []

    const results = gates.map((gate, index) =>
      run(() => {
        started.push(index)
        return gate.promise
      }),
    )
    await settle()
    expect(started).toEqual([0, 1])

    gates[1].resolve('b')
    await settle()
    expect(started).toEqual([0, 1, 2])

    gates[0].resolve('a')
    gates[2].resolve('c')
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c'])
  })

  it('releases the slot when a task rejects so later tasks still run', async () => {
    const run = createConcurrencyLimiter(1)
    const first = deferred<never>()
    const started: string[] = []

    const failing = run(() => {
      started.push('first')
      return first.promise
    })
    const following = run(() => {
      started.push('second')
      return Promise.resolve('ok')
    })
    await settle()
    expect(started).toEqual(['first'])

    first.reject(new Error('corrupt input'))
    await expect(failing).rejects.toThrow('corrupt input')
    expect(await following).toBe('ok')
  })

  it('releases the slot when the task factory throws synchronously', async () => {
    const run = createConcurrencyLimiter(1)

    await expect(
      run(() => {
        throw new Error('sync failure')
      }),
    ).rejects.toThrow('sync failure')
    expect(await run(() => Promise.resolve('after'))).toBe('after')
  })

  it('treats a non-finite or sub-one bound as unlimited', async () => {
    for (const bound of [0, -3, Number.POSITIVE_INFINITY, Number.NaN]) {
      const run = createConcurrencyLimiter(bound)
      const gates = [deferred<number>(), deferred<number>(), deferred<number>()]
      const started: number[] = []
      const results = gates.map((gate, index) =>
        run(() => {
          started.push(index)
          return gate.promise
        }),
      )
      await settle()
      expect(started).toEqual([0, 1, 2])
      gates.forEach((gate, index) => gate.resolve(index))
      expect(await Promise.all(results)).toEqual([0, 1, 2])
    }
  })
})
