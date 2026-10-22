/**
 * Bound how many asynchronous tasks run at once. Tasks start in submission
 * order; a rejected or throwing task releases its slot so one failure cannot
 * block the queue. A bound below one or non-finite means unlimited.
 */
export const createConcurrencyLimiter = (
  maxConcurrent: number,
): (<T>(task: () => Promise<T>) => Promise<T>) => {
  const limit = Number.isFinite(maxConcurrent) ? Math.floor(maxConcurrent) : 0
  if (limit < 1) {
    return (task) => Promise.resolve().then(task)
  }

  let active = 0
  const waiting: Array<() => void> = []

  const release = (): void => {
    active -= 1
    const next = waiting.shift()
    if (next) {
      next()
    }
  }

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      waiting.push(() => {
        active += 1
        resolve()
      })
    })
  }

  return async (task) => {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}
