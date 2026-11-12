import { expect, test, type Page } from '@playwright/test'

// Synthetic state mutations of the public snapshot only; no eval or model access.
async function patchSnapshot(page: Page, script: string) {
  await page.route('**/data/snapshot.js', async (route) => {
    const r = await route.fetch()
    await route.fulfill({ response: r, body: `${await r.text()}\n${script}` })
  })
}

test('TC-REV-13 filters, keyboard navigation, history, focus and scroll restoration', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 740 })
  await page.goto('/')
  await page.getByLabel('Risk', { exact: true }).selectOption('high')
  await expect(page.getByRole('status')).toHaveText('16 of 31 cases')
  const link = page.locator('a.row').nth(8)
  const id = await link.getAttribute('id')
  await link.scrollIntoViewIfNeeded()
  await link.focus()
  const y = await page.evaluate(() => window.scrollY)
  await link.press('Enter')
  await expect(page.locator('#case-title')).toBeFocused()
  await expect(page.locator('.case-summary')).toContainText('Next step:')
  await page.goBack()
  await expect(page.getByLabel('Risk', { exact: true })).toHaveValue('high')
  await expect(page.locator(`[id="${id}"]`)).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(y, 0)
  await page.goForward()
  await expect(page.locator('#case-title')).toBeFocused()
  await page.getByRole('button', { name: '← All cases' }).click()
  await expect(page.locator(`[id="${id}"]`)).toBeFocused()
  await page.getByLabel('Status', { exact: true }).selectOption('closed')
  await expect(page.getByText('No cases match these filters.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.locator('a.row')).toHaveCount(31)
  await page.goto('/#case=E-NOT-FOUND')
  await expect(page.getByRole('alert')).toContainText('could not be loaded')
  await page.getByRole('button', { name: '← All cases' }).click()
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible()
})

test('TC-DEMO-05 mixed KYC attachments remain distinct and no readonly checklist instruction', async ({ page }) => {
  await patchSnapshot(page, `{
    const c = globalThis.TRUNKS_DEMO.details.E0045;
    const original = c.attachments[0];
    c.attachments = ['delivered', 'pending', 'failed', 'discarded'].map((state, i) => ({...original, ordinal:i, filename:'sample-'+i+'.pdf', kycTransfer:{...original.kycTransfer, state, error:state==='failed'?'infected':null, removed:false}}));
  }`)
  await page.goto('/#case=E0045')
  await expect(page.getByText('Recorded transfer: completed', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Transfer pending', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Blocked by the virus scan; not transferred', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Blocked by the virus scan; handled manually', { exact: true })).toHaveCount(1)
  await expect(page.getByText(/Removal is not demonstrated/)).toHaveCount(1)
  await expect(page.locator('.case-summary')).toContainText('Review KYC hand-off status')
  await expect(page.locator('main')).not.toContainText('removal pending')
  await page.goto('/#case=E0225')
  await expect(page.getByText(/This demo shows the verification checklist/)).toBeVisible()
  await expect(page.getByText(/Tick every checklist item/)).toHaveCount(0)
  await expect(page.locator('main input, main select, main textarea')).toHaveCount(0)
})

for (const mode of ['missing', 'incomplete', 'risk-change'] as const) {
  test(`TC-DEMO-05 summary generation safety: ${mode}`, async ({ page }) => {
    await patchSnapshot(page, `{
      const c=globalThis.TRUNKS_DEMO.details.E0225;
      ${mode === 'missing' ? 'c.e3=null;' : mode === 'incomplete' ? 'c.e3.complete=false; c.e3.actions=[{action:"fake",details:"OLD ACTION MUST NOT SHOW"}];' : 'c.e3.pendingRisk="low"; c.e3.risk.held="high"; c.e3.risk.applied="low";'}
    }`)
    await page.goto('/#case=E0225')
    const summary = page.locator('.case-summary')
    await expect(summary).toContainText('High risk')
    if (mode === 'missing') await expect(summary).toContainText('Analysis is not available yet')
    if (mode === 'incomplete') {
      await expect(summary).toContainText('Analysis is being updated')
      await expect(page.locator('main')).not.toContainText('OLD ACTION MUST NOT SHOW')
    }
    if (mode === 'risk-change') {
      await expect(summary).toContainText('current risk remains high')
      await expect(summary).toContainText('Risk after reprocessing: low')
    }
  })
}

test('TC-DEMO-05 reply statuses and missing signal results stay explicit', async ({ page }) => {
  await patchSnapshot(page, `{
    const c=globalThis.TRUNKS_DEMO.details.E0225, r=c.e3.replies[0];
    c.signalDetails=[];
    c.e3.replies=['draft','approved','sent','rejected'].map((status,i)=>({...r,id:'synthetic-'+i,status,outOfDate:false}));
    c.e3.replies.push({...r,id:'synthetic-old',outOfDate:true});
  }`)
  await page.goto('/#case=E0225')
  await expect(page.getByText('No signals yet.')).toBeVisible()
  await expect(page.getByText('No warning signals detected.', { exact: true })).toHaveCount(0)
  for (const text of ['Draft', 'Approved, waiting to be sent by a person', 'Marked as sent', 'Rejected', 'Out of date — work on the current draft']) await expect(page.getByTestId('reply').getByText(text, { exact: true })).toBeVisible()
  await expect(page.locator('main input, main select, main textarea')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
})

test('TC-REV-13 light/dark/375px evidence, order, target sizes and contrast', async ({ page }) => {
  const contrast = (a: string, b: string) => {
    const luminance = (s: string) => {
      const c = s.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
      return .2126 * c[0]! + .7152 * c[1]! + .0722 * c[2]!
    }
    const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)
  }
  for (const [scheme, width] of [['light',1440],['dark',1440],['light',375]] as const) {
    await page.setViewportSize({ width, height:900 })
    await page.emulateMedia({ colorScheme:scheme })
    await page.goto('/')
    await expect(page.locator('a.row')).toHaveCount(31)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const colors = await page.locator('a.row .meta').first().evaluate((e) => ({fg:getComputedStyle(e).color,bg:getComputedStyle(e.closest('a')!).backgroundColor}))
    expect(contrast(colors.fg,colors.bg)).toBeGreaterThanOrEqual(4.5)
    const focusTarget=page.locator('a.row').first()
    await focusTarget.focus()
    const focusColors=await focusTarget.evaluate((e)=>({fg:getComputedStyle(e).outlineColor,bg:getComputedStyle(e).backgroundColor,width:parseFloat(getComputedStyle(e).outlineWidth)}))
    expect(focusColors.width).toBeGreaterThanOrEqual(2)
    expect(contrast(focusColors.fg,focusColors.bg)).toBeGreaterThanOrEqual(3)
    expect((await page.getByRole('link',{name:'← About Trunks'}).boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await page.screenshot({path:`/tmp/trunks-design-list-${scheme}-${width}.png`,fullPage:false})
    await page.goto('/#case=E0225')
    await expect(page.locator('#case-title')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const summary=await page.locator('.case-summary').boundingBox(), main=await page.locator('.case-main').boundingBox(), side=await page.locator('.case-side').boundingBox()
    expect(summary!.y+summary!.height).toBeLessThanOrEqual(main!.y)
    if(width===375) expect(main!.y+main!.height).toBeLessThanOrEqual(side!.y)
    else expect(main!.x+main!.width).toBeLessThanOrEqual(side!.x)
    expect(await page.locator('main').evaluate((e) => {const a=e.querySelector('.case-summary')!,b=e.querySelector('.case-main')!,c=e.querySelector('.case-side')!; return Boolean(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)&&Boolean(b.compareDocumentPosition(c)&Node.DOCUMENT_POSITION_FOLLOWING)})).toBe(true)
    for(const summary of await page.locator('main summary').all()) expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await page.screenshot({path:`/tmp/trunks-design-case-${scheme}-${width}.png`,fullPage:true})
  }
})

test('TC-REV-13 each list history entry restores its own case and position', async ({ page }) => {
  await page.setViewportSize({width:1280,height:740})
  await page.goto('/')
  const a=page.locator('a.row').nth(5)
  await a.scrollIntoViewIfNeeded()
  const aId=await a.getAttribute('id')
  const y=await page.evaluate(()=>window.scrollY)
  await a.click()
  await expect(page.locator('#case-title')).toBeFocused()
  await page.getByRole('button',{name:'← All cases'}).click()
  const b=page.locator('a.row').nth(14)
  await b.scrollIntoViewIfNeeded()
  await b.click()
  await expect(page.locator('#case-title')).toBeFocused()
  await page.goBack()
  await expect(page.getByRole('heading',{name:'Cases'})).toBeVisible()
  await page.goBack()
  await expect(page.locator('#case-title')).toBeFocused()
  await page.goBack()
  await expect(page.locator(`[id="${aId}"]`)).toBeFocused()
  await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeCloseTo(y,0)
})
