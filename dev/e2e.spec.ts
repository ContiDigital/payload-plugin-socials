import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('renders the social control center and product composer accessibly', async ({ page }) => {
  test.setTimeout(90_000)

  const login = await page.request.post('/api/users/login', {
    data: {
      email: process.env.DEV_ADMIN_EMAIL || 'dev@payloadcms.com',
      password: process.env.DEV_ADMIN_PASSWORD || 'test',
    },
  })
  expect(login.ok()).toBe(true)

  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
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
  await expect(page.getByLabel('Post copy')).toBeVisible()
  await expect(page.getByLabel('Pin title')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish now' })).toBeDisabled()

  const accessibility = await new AxeBuilder({ page }).include('.socials-composer').analyze()
  expect(accessibility.violations).toEqual([])
})
