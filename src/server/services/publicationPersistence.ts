import type { PublishedRef } from '../../types/index.js'

import { PublicationPersistenceError } from '../utilities/errors.js'

export const persistPublicationAudit = async <T>(args: {
  persist: () => Promise<T>
  publishedRef: PublishedRef
}): Promise<T> => {
  try {
    return await args.persist()
  } catch (cause) {
    throw new PublicationPersistenceError(args.publishedRef, cause)
  }
}
