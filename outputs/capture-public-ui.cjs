const fs = require('node:fs')
const path = require('node:path')

const packageBin = process.env.PATH.split(path.delimiter).find((entry) =>
  fs.existsSync(path.resolve(entry, '..', 'playwright', 'package.json')),
)
if (!packageBin) throw new Error('Playwright package was not found in the npm exec environment.')
const { chromium } = require(path.resolve(packageBin, '..', 'playwright'))

const baseUrl = 'http://localhost:5173/'
const output = path.resolve('outputs')
const pageErrors = []

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(output, 'ui-review-entry-desktop.png') })
  await page.getByRole('button', { name: 'Browse catalog without an account' }).click()
  await page.getByRole('textbox', { name: 'Search library' }).waitFor()
  await page.waitForSelector('.book-card, .catalog-empty-state, .inline-error', { state: 'visible', timeout: 20000 })

  const catalogTitles = await page.locator('.book-card').count()
  const desktopSize = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  await page.screenshot({ path: path.join(output, 'ui-review-catalog-desktop.png'), fullPage: true })

  await page.getByRole('button', { name: 'View details' }).first().click()
  await page.locator('.book-detail-card').waitFor({ state: 'visible' })
  await page.screenshot({ path: path.join(output, 'ui-review-book-details-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const mobileSize = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  await page.screenshot({ path: path.join(output, 'ui-review-book-details-mobile.png') })
  await page.getByRole('button', { name: 'Back to catalog' }).click()
  await page.getByRole('textbox', { name: 'Search library' }).waitFor()
  await page.screenshot({ path: path.join(output, 'ui-review-catalog-mobile.png') })

  console.log(JSON.stringify({ catalogTitles, desktopSize, mobileSize, pageErrors }, null, 2))
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
