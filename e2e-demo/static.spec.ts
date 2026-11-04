// TC-DEMO-02, TC-DEMO-04 (PRD R-DEMO-02 v0.7.25; site interface T1–T4, §4): the static demo snapshot under the website's
// CSP shows the processed demo, names cases by their sample, renders no change control, and makes no request but for
// its own files.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test('TC-DEMO-04 / TC-DEMO-02 static demo: readable under the site CSP, thin bar with About, sample IDs, no change control, no fetch / XHR, nothing stored', async ({ page, baseURL }) => {
  const requests: Array<{ method: string; url: string; type: string }> = []
  page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), type: r.resourceType() }))
  const csp: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text())
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible()
  // A2 (PRD R-DEMO-02 v0.7.25): one thin bar — back link, fictional data, read-only, the snapshot's version — and the
  // notes folded into «About this demo» (TC-DEMO-02: still on the page, shown when opened)
  const bar = page.locator('.demo-bar')
  const version = JSON.parse(readFileSync(`${process.env.DEMO_PREVIEW_DIR ?? 'dist-demo'}/snapshot-info.json`, 'utf8')).version as string
  await expect(bar.locator('p').first()).toHaveText('← About Trunks · Demo · Fictional data · View only')
  await expect(page.getByRole('link', { name: '← About Trunks' })).toHaveAttribute('href', '/inbox/')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
  const about = bar.locator('details')
  await expect(about.getByText(/This demo shows precomputed results/)).toBeHidden()
  await about.locator('summary', { hasText: 'About this demo' }).click()
  await expect(about.getByText(/No live mailbox or model is connected/)).toBeVisible()
  await expect(about.getByText(`Demo version: v${version}`, { exact: false })).toBeVisible()
  await expect(about.getByText(/Snapshot built:/)).toBeVisible()
  await expect(page.getByText(/Overdue labels do not represent a live backlog/)).toBeVisible()
  await expect(bar).not.toContainText('evaluation set')
  await expect(bar).not.toContainText('Toolkit')
  // A1: no user, role or Sign out; no warning banner outside the bar
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  await expect(page.getByText('demo-reviewer')).toHaveCount(0)
  await expect(page.locator('header')).toHaveCount(0)
  await expect(page.locator('.banner[role="alert"]')).toHaveCount(0)
  // all 30 demo cases (test plan §2.12)
  await expect(page.locator('ul.cases > li > a.row')).toHaveCount(30)
  // A3 on the list: only the read-only filters, nothing else to fill in
  await expect(page.locator('main input, main textarea')).toHaveCount(0)
  await expect(page.locator('main select')).toHaveCount(3)
  // T2: a deep link by sample ID (as from the website: a fresh page load) opens that case
  await page.goto('about:blank')
  await page.goto('/#case=E0225')
  await expect(page.getByText('Classification evidence', { exact: true })).toBeVisible()
  await expect(page.getByText('northwind-robotlcs.example').first()).toBeVisible()
  // every panel of the case is there (self-test F5)
  for (const h of ['Key details', 'Signals', 'Email type', 'Related records', 'Risk', 'Reply', 'Suggested next steps', 'Queue and owner', 'Check the bank details request']) await expect(page.getByRole('heading', { name: h })).toBeVisible()
  // what the website quotes from this case (site request 2026-11-03) is still shown
  for (const s of ['Call the phone number on file', 'Do not use any phone number or link from the email']) await expect(page.getByText(s)).toBeVisible()
  await page.getByText('Details extracted by rules', { exact: true }).click()
  await expect(page.getByText(/ending 4893/).first()).toBeVisible()
  // A3: the reply says how it leaves a real deployment
  await expect(page.getByText('In a real deployment, approve and copy the reply, then send it from your own mail client. Trunks cannot send email.')).toBeVisible()
  // A3: every demo case, every fold opened — no change control at all: the only buttons are navigation, the only
  // other interactive elements are the folds; no select, input or textarea
  const before = requests.length
  await page.goto('about:blank')
  await page.goto('/')
  const ids = await page.evaluate(() => Object.keys((globalThis as unknown as { DOI_DEMO: { details: object } }).DOI_DEMO.details))
  expect(ids.length).toBe(30)
  for (const id of ids) {
    await page.goto(`/#case=${id}`)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Signals' })).toBeVisible()
    if (await page.getByRole('heading', { name: 'Reply', exact: true }).count()) {
      await expect(page.getByText('In a real deployment, approve and copy the reply, then send it from your own mail client. Trunks cannot send email.')).toBeVisible()
    }
    for (const s of await page.locator('main summary').all()) await s.click()
    expect(await page.locator('main select, main input, main textarea').count(), id).toBe(0)
    const buttons = await page.locator('main button').allTextContents()
    expect(buttons, id).toEqual(['← All cases'])
    await expect(page.locator('[aria-disabled="true"]')).toHaveCount(0)
  }
  expect(requests.slice(before).filter((r) => r.method !== 'GET' || r.type === 'fetch' || r.type === 'xhr'), 'no request for any change').toEqual([])
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
