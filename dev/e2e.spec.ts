import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('renders the social control center and product composer accessibly', async ({ page }) => {
  test.setTimeout(90_000)

  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Email').fill(process.env.DEV_ADMIN_EMAIL || 'dev@payloadcms.com')
  await page.getByLabel('Password').fill(process.env.DEV_ADMIN_PASSWORD || 'test')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page).toHaveTitle(/Dashboard/)

  let composeAttempts = 0
  await page.route('**/api/socials/pinterest/boards', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ boards: [{ id: 'board-e2e', name: 'E2E board' }] }),
      contentType: 'application/json',
      status: 200,
    })
  })
  await page.route('**/api/socials/compose/publish', async (route) => {
    composeAttempts += 1
    const body = route.request().postDataJSON() as {
      content: { title: string }
      targets: Array<{ input: { boardId?: string }; platform: string }>
    }
    expect(body.content.title).toBe('E2E launch')
    expect(body.targets).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ boardId: 'board-e2e' }),
        platform: 'pinterest',
      }),
    ])
    if (composeAttempts === 1) {
      await route.fulfill({
        body: JSON.stringify({
          anyPublished: true,
          results: [
            {
              ok: true,
              platform: 'pinterest',
              publishedRef: {
                externalId: 'pin-e2e',
                externalUrl: 'https://www.pinterest.com/pin/pin-e2e',
                platform: 'pinterest',
              },
            },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      })
      return
    }
    await route.fulfill({
      body: JSON.stringify({ error: 'Pinterest unavailable' }),
      contentType: 'application/json',
      status: 502,
    })
  })

  const accessProbe = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && response.url().endsWith('/api/socials/access'),
  )
  await page.goto('/admin/socials', { waitUntil: 'domcontentloaded' })
  const accessResponse = await accessProbe
  expect(accessResponse.ok()).toBe(true)
  await expect(accessResponse.json()).resolves.toMatchObject({ publisher: true })
  await expect(page.getByRole('heading', { level: 1, name: 'Socials' })).toBeVisible()
  await expect(
    page.getByRole('tablist', { name: 'Socials view' }).getByRole('tab', { name: 'Connections' }),
  ).toBeVisible()

  const standaloneComposer = page
    .locator('.socials-composer')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Standalone composer' }) })
  await expect(standaloneComposer).toBeVisible({ timeout: 30_000 })
  await standaloneComposer.getByLabel('Post title').fill('E2E launch')
  await standaloneComposer.getByLabel('Pinterest').check()
  await standaloneComposer.getByLabel('Pinterest destination').selectOption('board-e2e')
  const publishSelected = standaloneComposer.getByRole('button', {
    name: 'Publish to selected channels',
  })
  await expect(publishSelected).toBeEnabled()
  await publishSelected.click()
  await expect(standaloneComposer.locator('.socials-composer__success')).toContainText('Published')
  await expect(standaloneComposer.getByRole('link', { name: 'View' })).toHaveAttribute(
    'href',
    'https://www.pinterest.com/pin/pin-e2e',
  )

  await publishSelected.click()
  await expect(page.getByText('Pinterest unavailable')).toBeVisible()
  expect(composeAttempts).toBe(2)

  const created = await page.request.post('/api/products', {
    data: { title: 'E2E product' },
  })
  expect(created.ok()).toBe(true)
  const product = (await created.json()) as { doc: { id: number | string } }
  await page.goto(`/admin/collections/products/${product.doc.id}`, {
    waitUntil: 'domcontentloaded',
  })

  const productMain = page.getByRole('main')
  const socialsTab = productMain.getByRole('button', { exact: true, name: 'Socials' })
  const composerHeading = productMain.getByRole('heading', {
    level: 2,
    name: 'Social composer',
  })
  await expect(async () => {
    await socialsTab.click()
    await expect(composerHeading).toBeVisible({ timeout: 1_000 })
  }).toPass({ intervals: [500, 1_000, 2_000], timeout: 30_000 })
  const platformTabs = page.getByRole('tablist', { name: 'Social platform' })
  await platformTabs.getByRole('tab', { name: 'Pinterest' }).click()
  await expect(page.getByLabel('Post copy')).toBeVisible()
  await expect(page.getByLabel('Pin title')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish now' })).toBeDisabled()

  const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const localDateTime = new Date(scheduledAt.getTime() - scheduledAt.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
  await page.getByLabel('Schedule post').fill(localDateTime)
  await expect(page.getByRole('button', { name: 'Schedule post' })).toBeDisabled()

  const accessibility = await new AxeBuilder({ page }).include('.socials-composer').analyze()
  expect(accessibility.violations).toEqual([])
})
