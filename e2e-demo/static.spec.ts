// TC-DEMO-04 (PRD R-DEMO-02; site interface T1–T4): the static demo snapshot under the website's CSP shows the
// processed demo, names cases by their sample, refuses every change, and makes no request but for its own files.
import { expect, test } from '@playwright/test'

test('TC-DEMO-04 static demo: readable under the site CSP, sample IDs, changes refused, no fetch / XHR, nothing stored', async ({ page, baseURL }) => {
  const requests: Array<{ method: string; url: string; type: string }> = []
  page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), type: r.resourceType() }))
  const csp: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text())
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible()
  await expect(page.getByText(/Read-only snapshot of the demo, built \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)).toBeVisible()
  await expect(page.getByText(/Demo: fictional data only/)).toBeVisible()
  // T3: version line, link back to the product page, not for search engines
  await expect(page.getByText(/Snapshot of v\d+\.\d+\.\d+/)).toBeVisible()
  await expect(page.getByRole('link', { name: '← Deal Ops Inbox' })).toHaveAttribute('href', '/inbox/')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
  // all 30 demo cases (test plan §2.12)
  await expect(page.locator('ul.cases > li > button.row')).toHaveCount(30)
  // T2: a deep link by sample ID (as from the website: a fresh page load) opens that case
  await page.goto('about:blank')
  await page.goto('/#case=E0225')
  await expect(page.getByRole('heading', { name: 'Classification' })).toBeVisible()
  await expect(page.getByText('northwind-robotlcs.example').first()).toBeVisible()
  // every panel of the case is there (self-test F5)
  for (const h of ['Classification', 'Fields', 'Signals', 'Classes', 'Links', 'Risk', 'Reply', 'Suggested actions', 'Queue and owner', 'Check the bank details request']) await expect(page.getByRole('heading', { name: h })).toBeVisible()
  // every change: announced as unavailable (T3), still focusable, refused in the page itself, no request (F5)
  // the header's Sign out too (Codex E5 round 2 F3)
  const changes = page.locator('button[aria-disabled="true"]')
  const n = await changes.count()
  expect(n).toBeGreaterThan(5)
  const before = requests.length
  for (let i = 0; i < n; i++) {
    const b = changes.nth(i)
    if (!(await b.isVisible())) continue
    // a keyboard user reaches it and hears why (Playwright will not click an aria-disabled button)
    await b.focus()
    await page.keyboard.press('Enter')
  }
  expect(requests.length, 'no request for any change').toBe(before)
  // Sign out explains itself as well
  await page.getByRole('button', { name: 'Sign out' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('header').getByText(/Demo: not available/)).toBeVisible()
  await expect(page.getByText(/Demo: not available\. This is a read-only snapshot/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '← All cases' })).not.toHaveAttribute('aria-disabled', 'true')
  // no link to a server export (F5)
  await page.goto('about:blank')
  await page.goto('/')
  await expect(page.locator('a[href*="/api/"]')).toHaveCount(0)
  // T1 / T4: no fetch or XHR at all, only GETs of the snapshot's own files, no CSP violation, nothing stored
  expect(requests.filter((r) => r.type === 'fetch' || r.type === 'xhr')).toEqual([])
  for (const r of requests) {
    expect(r.method).toBe('GET')
    expect(r.url.startsWith(baseURL!) || r.url === 'about:blank').toBe(true)
  }
  expect(csp).toEqual([])
  expect(await page.evaluate(() => [sessionStorage.length, localStorage.length])).toEqual([0, 0])
})
