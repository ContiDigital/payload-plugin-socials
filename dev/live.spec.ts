import { describe, expect, it } from 'vitest'

const platform = process.env.SOCIALS_LIVE_PLATFORM

const requireSecret = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required for the selected live contract test`)
  }
  return value
}

const expectOk = async (response: Response): Promise<void> => {
  expect(response.status, `upstream returned HTTP ${response.status}`).toBeGreaterThanOrEqual(200)
  expect(response.status, `upstream returned HTTP ${response.status}`).toBeLessThan(300)
  await response.body?.cancel()
}

describe.skipIf(!platform)('live provider contracts', () => {
  it.skipIf(platform !== 'pinterest')('authenticates with Pinterest API v5', async () => {
    const token = requireSecret('PINTEREST_ACCESS_TOKEN')
    await expectOk(
      await fetch('https://api.pinterest.com/v5/user_account', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
  })

  it.skipIf(platform !== 'meta')(
    'authenticates with the configured Meta Graph version',
    async () => {
      const token = requireSecret('META_ACCESS_TOKEN')
      const version = process.env.META_API_VERSION ?? 'v25.0'
      await expectOk(
        await fetch(`https://graph.facebook.com/${version}/me?fields=id,name`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      )
    },
  )

  it.skipIf(platform !== 'gbp')('lists Google Business Profile accounts', async () => {
    const token = requireSecret('GBP_ACCESS_TOKEN')
    await expectOk(
      await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
  })
})
