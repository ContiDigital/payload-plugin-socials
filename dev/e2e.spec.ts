import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('renders the social control center and product composer accessibly', async ({ page }) => {
  test.setTimeout(90_000)

  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Email').fill(process.env.DEV_ADMIN_EMAIL || 'dev@payloadcms.com')
  await page.getByLabel('Password').fill(process.env.DEV_ADMIN_PASSWORD || 'test')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page).toHaveTitle(/Dashboard/)

  await page.goto('/admin/socials', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Socials' })).toBeVisible()
  await expect(
    page.getByRole('tablist', { name: 'Socials view' }).getByRole('tab', { name: 'Connections' }),
  ).toBeVisible()

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
