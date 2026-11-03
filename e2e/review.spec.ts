import { expect, test, type Page } from '@playwright/test'

let password = 'e2e-admin-password-1'

/** Sign in as the seeded admin; the first sign-in must choose a new password. */
async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  const next = page.getByRole('heading', { name: /Choose a new password|Cases/ })
  await expect(next).toBeVisible()
  if ((await next.textContent()) === 'Choose a new password') {
    await page.getByLabel('Current password').fill(password)
    password = 'e2e-admin-password-2'
    await page.getByLabel('New password (12 characters or more)').fill(password)
    await page.getByRole('button', { name: 'Save' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test('TC-REV-01 / E2E-03 a mail with remote images, scripts and CSS: the page makes no outside request and shows text only', async ({ page }) => {
  const outside: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.hostname !== '127.0.0.1') outside.push(r.url())
  })
  let dialogs = 0
  page.on('dialog', async (d) => {
    dialogs++
    await d.dismiss()
  })
  await signIn(page)
  await page.getByText('Remote content test').click()
  await expect(page.getByRole('heading', { name: 'Remote content test' })).toBeVisible()
  const body = page.locator('pre.body')
  await expect(body).toContainText('Hello team')
  expect(await page.locator('main img, main script, main link, main iframe').count()).toBe(0)
  await page.waitForTimeout(500)
  expect(outside).toEqual([])
  expect(dialogs).toBe(0)
  expect(await page.title()).toBe('Deal Ops Inbox')
})

test('E2E-06 the case list and the detail are usable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 })
  await signIn(page)
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scroll).toBeLessThanOrEqual(375)
  await page.getByText('Payment £10,000.00 ref NW-001').click()
  await expect(page.getByText('£10,000.00').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  // a detail with every E3 panel (risk, links, reply, verification task)
  await page.getByRole('button', { name: '← All cases' }).click()
  await page.getByText('New bank details').click()
  await expect(page.getByRole('heading', { name: 'Check the bank details request' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})

test('TC-REV-02 model reasons and field values containing Markdown images and links stay plain text; no outside request', async ({ page }) => {
  const outside: string[] = []
  page.on('request', (r) => {
    if (new URL(r.url()).hostname !== '127.0.0.1') outside.push(r.url())
  })
  await signIn(page)
  await page.getByText('Model text test').click()
  await expect(page.getByRole('heading', { name: 'Classification' })).toBeVisible()
  await expect(page.getByText('![pixel](https://evil.example/p.png)', { exact: false })).toBeVisible()
  expect(await page.locator('main img, main a[href*="evil"]').count()).toBe(0)
  await page.waitForTimeout(300)
  expect(outside).toEqual([])
})

test('TC-RED-09a in the review UI [NAME_n] shows the name; [ACCOUNT_n] never the number; a field holding an account placeholder is void', async ({ page }) => {
  await signIn(page)
  await page.getByText('Model text test').click()
  await expect(page.locator('ul.labels')).toContainText('Amelia paid into (account number)')
  await expect(page.locator('dl.fields')).toContainText('Amelia Hart')
  // (the original mail above shows the IBAN by design, R-REV-02; model text never does)
  for (const part of ['ul.labels', 'dl.fields']) await expect(page.locator(part)).not.toContainText('GB82')
  await expect(page.locator('dl.fields')).toContainText('account or ID placeholder in a value')
})

test('TC-RED-04 (review UI) a possible-KYC attachment is marked in the Case; an ordinary one is not', async ({ page }) => {
  await signIn(page)
  await page.getByText('KYC documents test').click()
  const items = page.locator('li', { hasText: '.pdf —' })
  await expect(items.filter({ hasText: 'passport.pdf' })).toContainText('Possible KYC document')
  await expect(items.filter({ hasText: 'invoice.pdf' })).not.toContainText('Possible KYC document')
})

// ---------- E3 (test plan §5) ----------

async function signInAs(page: Page, user: string) {
  await page.goto('/')
  // wait until the page shows either state: an instant check could run before it loaded and miss a signed-in session
  const signOut = page.getByRole('button', { name: 'Sign out' })
  await expect(signOut.or(page.getByLabel('Username'))).toBeVisible()
  if (await signOut.isVisible()) await signOut.click()
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(`${user}-password-1234`)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible()
}
const openCase = async (page: Page, subject: string) => {
  await page.getByText(subject, { exact: true }).click()
  await expect(page.getByRole('heading', { name: subject })).toBeVisible()
}
const control = (path: string, body?: object) => fetch(`http://127.0.0.1:4318${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}).then((r) => r.json())

test('E2E-01 «I have paid»: fields, links and reply; approve; copy recipient, subject and text; mark as sent', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await signInAs(page, 'rita')
  await openCase(page, 'I have paid')
  await expect(page.locator('dl.fields')).toBeVisible()
  await expect(page.getByText('Amelia Hart (C001)')).toBeVisible()
  await expect(page.getByText('Amelia Hart · NW-001')).toBeVisible()
  const reply = page.getByTestId('reply').first()
  await expect(reply).toContainText('payment_need_evidence')
  await reply.getByRole('button', { name: 'Approve' }).click()
  await expect(reply).toContainText('Approved, waiting to be sent by a person')
  // every copy button re-checks the approval on the server (C-DRF-8, Codex E3 F2)
  for (const [button, expected] of [['Copy recipient', 'amelia@hartfamily.example'], ['Copy subject', /^Re: /], ['Copy text', /^Dear Amelia Hart,/]] as const) {
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await reply.getByRole('button', { name: button }).click()
    // the copy waits for the server's re-check, then writes the clipboard
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(typeof expected === 'string' ? new RegExp(`^${expected.replace(/[.]/g, '\\.')}$`) : expected)    // every copy shows its result (R-REV-04 v0.7.20)
    await expect(reply.getByRole('status')).toHaveText(`Copied the ${button.slice(5)}.`)
  }
  await reply.getByRole('button', { name: 'Mark as sent' }).click()
  await expect(reply).toContainText('Marked as sent')
})

/** Paul's approved «I have paid» reply; every copy test starts on a fresh page, so no clipboard write is left over. */
async function approvedReply(page: Page) {
  await signInAs(page, 'paul')
  await openCase(page, 'I have paid')
  const reply = page.getByTestId('reply').first()
  if (await reply.getByRole('button', { name: 'Approve' }).isVisible()) {
    await reply.getByRole('button', { name: 'Approve' }).click()
    await expect(reply).toContainText('Approved, waiting to be sent by a person')
  }
  return reply
}
type ClipWindow = { calls: number; pending: { value: string; settle: () => void }[]; clip: string }
const calls = (page: Page) => page.evaluate(() => (window as unknown as ClipWindow).calls)

test('TC-REV-04 copy feedback: a refused clipboard shows the failure and the text to copy by hand (R-REV-04 v0.7.20)', async ({ page }) => {
  const reply = await approvedReply(page)
  await page.evaluate(() => {
    const w = window as unknown as ClipWindow
    w.calls = 0
    navigator.clipboard.writeText = () => { w.calls += 1; return Promise.reject(new DOMException('denied', 'NotAllowedError')) }
  })
  await reply.getByRole('button', { name: 'Copy recipient' }).click()
  await expect(reply.getByRole('alert')).toHaveText('Copy failed: select the recipient below and copy it by hand.')
  await expect(reply.getByRole('textbox', { name: 'The recipient to copy by hand' })).toHaveValue('amelia@hartfamily.example')
  await expect(reply.getByRole('status')).toHaveCount(0)
  expect(await calls(page)).toBe(1)
})

test('TC-REV-04 copy feedback: a clipboard that never answers fails at exactly 3 s (controlled clock, R-REV-04 v0.7.20)', async ({ page }) => {
  // the page's timers run on a controlled clock, so CI load cannot move the deadline (Codex E4 r10 N3)
  await page.clock.install()
  const reply = await approvedReply(page)
  await page.evaluate(() => {
    const w = window as unknown as ClipWindow
    w.calls = 0
    navigator.clipboard.writeText = () => { w.calls += 1; return new Promise<void>(() => undefined) }
  })
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000))
  await reply.getByRole('button', { name: 'Copy text' }).click()
  await expect.poll(() => calls(page)).toBe(1) // the write has started; the clock stands still
  await page.clock.runFor(2999)
  await page.waitForTimeout(300) // real time only: the page's clock does not move
  await expect(reply.getByRole('alert')).toHaveCount(0)
  await expect(reply.getByRole('status')).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(reply.getByRole('alert')).toHaveText('Copy failed: select the text below and copy it by hand.')
  await expect(reply.getByRole('textbox', { name: 'The text to copy by hand' })).toHaveValue(/^Dear Amelia Hart,/)
  await page.clock.resume()
})

test('TC-REV-04 copy feedback: the box holds the server text of the latest copy; an older answer arriving late changes nothing (R-REV-04 v0.7.20)', async ({ page }) => {
  const reply = await approvedReply(page)
  let requests = 0
  let releaseFirst = () => undefined as void
  const firstHeld = new Promise<void>((r) => { releaseFirst = r })
  await page.route('**/replies/*/copy', async (route) => {
    requests += 1
    const n = requests
    const res = await route.fetch()
    const body = { ...(await res.json()), recipient: `fresh-${n}@hartfamily.example`, subject: `Re: FRESH-${n}`, text: `fresh text ${n}` }
    if (n === 1) await firstHeld
    await route.fulfill({ response: res, json: body })
  })
  // a synchronously throwing clipboard is a failure too (Codex E4 r8 F2); each call is counted (Codex E4 r10 F2)
  await page.evaluate(() => {
    const w = window as unknown as ClipWindow
    w.calls = 0
    navigator.clipboard.writeText = () => { w.calls += 1; throw new Error('no clipboard') }
  })
  await reply.getByRole('button', { name: 'Copy subject' }).click()
  await expect.poll(() => requests).toBe(1)
  await reply.getByRole('button', { name: 'Copy text' }).click()
  await expect(reply.getByRole('textbox', { name: 'The text to copy by hand' })).toHaveValue('fresh text 2')
  expect(await calls(page)).toBe(1)
  await expect(reply).toHaveAttribute('data-copies-done', '1')
  // let the older answer arrive and wait until the page has finished handling it (Codex E4 r11)
  releaseFirst()
  await expect(reply).toHaveAttribute('data-copies-done', '2')
  expect(requests).toBe(2)
  expect(await calls(page)).toBe(1) // the older copy never reached the clipboard
  await expect(reply.getByRole('alert')).toHaveText('Copy failed: select the text below and copy it by hand.')
  await expect(reply.getByRole('textbox')).toHaveCount(1)
  await expect(reply.getByRole('textbox', { name: 'The text to copy by hand' })).toHaveValue('fresh text 2')
  await page.unroute('**/replies/*/copy')
})

test('TC-REV-04 copy feedback: an older clipboard write that finishes late never overwrites a newer copy (R-REV-04 v0.7.20)', async ({ page }) => {
  // the clock stands still, so no deadline passes while the test settles the writes one by one (Codex E4 r11)
  await page.clock.install()
  const reply = await approvedReply(page)
  // each native write waits until the test settles it; the clipboard keeps what was written last (Codex E4 r9 N1)
  await page.evaluate(() => {
    const w = window as unknown as ClipWindow
    w.calls = 0
    w.pending = []
    w.clip = 'before'
    navigator.clipboard.writeText = (value: string) => new Promise<void>((resolve) => {
      w.calls += 1
      w.pending.push({ value, settle: () => { w.clip = value; resolve() } })
    })
  })
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000))
  const pending = () => page.evaluate(() => (window as unknown as ClipWindow).pending.length)
  await reply.getByRole('button', { name: 'Copy subject' }).click()
  await expect.poll(() => calls(page)).toBe(1)
  await reply.getByRole('button', { name: 'Copy text' }).click()
  // the newer copy has handled its answer: it waits in the queue (or, without one, has started writing)
  await expect(reply).toHaveAttribute('data-copies-answered', '2')
  // settle the newest unsettled write first, as a slow clipboard might, until both copies are done
  for (let i = 0; i < 2; i += 1) {
    await expect.poll(pending).toBeGreaterThan(0)
    await page.evaluate(() => (window as unknown as ClipWindow).pending.pop()?.settle())
  }
  await expect(reply).toHaveAttribute('data-copies-done', '2')
  await expect(reply.getByRole('status')).toHaveText('Copied the text.')
  expect(await page.evaluate(() => (window as unknown as ClipWindow).clip)).toMatch(/^Dear Amelia Hart,/)
  expect(await calls(page)).toBe(2)
  await page.clock.resume()
})

test('TC-REV-04 copy feedback: a queued copy that was superseded before its turn never writes (R-REV-04 v0.7.20)', async ({ page }) => {
  // A is writing, B waits in the queue, C supersedes B: once A settles, C writes next and B never starts (Codex E4 r12)
  await page.clock.install()
  const reply = await approvedReply(page)
  await page.evaluate(() => {
    const w = window as unknown as ClipWindow
    w.calls = 0
    w.pending = []
    w.clip = 'before'
    navigator.clipboard.writeText = (value: string) => new Promise<void>((resolve) => {
      w.calls += 1
      w.pending.push({ value, settle: () => { w.clip = value; resolve() } })
    })
  })
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000))
  const pendingValues = () => page.evaluate(() => (window as unknown as ClipWindow).pending.map((p) => p.value))
  await reply.getByRole('button', { name: 'Copy recipient' }).click()
  await expect.poll(() => calls(page)).toBe(1)
  await reply.getByRole('button', { name: 'Copy subject' }).click()
  await expect(reply).toHaveAttribute('data-copies-answered', '2')
  await reply.getByRole('button', { name: 'Copy text' }).click()
  await expect(reply).toHaveAttribute('data-copies-answered', '3')
  expect(await calls(page)).toBe(1) // B and C wait behind A
  await page.evaluate(() => (window as unknown as ClipWindow).pending.pop()?.settle()) // A settles
  await expect.poll(pendingValues).toHaveLength(1)
  expect((await pendingValues())[0]).toMatch(/^Dear Amelia Hart,/) // the next write is C's text, not B's subject
  expect(await calls(page)).toBe(2)
  await page.evaluate(() => (window as unknown as ClipWindow).pending.pop()?.settle()) // C settles
  await expect(reply).toHaveAttribute('data-copies-done', '3')
  await expect(reply.getByRole('status')).toHaveText('Copied the text.')
  expect(await page.evaluate(() => (window as unknown as ClipWindow).clip)).toMatch(/^Dear Amelia Hart,/)
  expect(await calls(page)).toBe(2) // B never started
  await page.clock.resume()
})

test('E2E-02 bank details change: high risk, a verification task, two different people after the cooling-off, safe_ack with fixed text', async ({ page }) => {
  await signInAs(page, 'ann')
  await openCase(page, 'New bank details')
  await expect(page.locator('.tag.risk-high').first()).toBeVisible()
  await expect(page.getByText('+44 7700 900101')).toBeVisible()
  const reply = page.getByTestId('reply').first()
  await expect(reply).toContainText('safe_ack')
  await expect(reply.getByLabel('Reply text')).toHaveCount(0)
  await expect(reply).toContainText("This reply's text is fixed and cannot be edited.")
  for (const box of await page.locator('ul.checklist input[type=checkbox]').all()) await box.check()
  await page.getByRole('button', { name: 'Checklist done' }).click()
  await expect(page.getByText('Checklist done — cooling-off period')).toBeVisible()
  // the same person
  await page.getByRole('button', { name: 'Approve as the second person' }).click()
  await expect(page.getByRole('alert')).toContainText('You ticked the checklist, so a different person must approve.')
  // an approver whose account ann created
  await signInAs(page, 'zed')
  await openCase(page, 'New bank details')
  await page.getByRole('button', { name: 'Approve as the second person' }).click()
  await expect(page.getByRole('alert')).toContainText('created the other')
  // an independent approver, after the cooling-off period
  await signInAs(page, 'paul')
  await openCase(page, 'New bank details')
  await page.getByRole('button', { name: 'Approve as the second person' }).click()
  await expect(page.getByText('Approved by a second person')).toBeVisible()
})

test('E2E-04 removing a class that lowers the risk needs an approver; risk and reply are recomputed; the earlier approval lapses; audit has before and after', async ({ page }) => {
  await signInAs(page, 'rita')
  await openCase(page, 'Bank letter please')
  const first = page.getByTestId('reply').first()
  await expect(first).toContainText('complaint_ack')
  await first.getByRole('button', { name: 'Approve' }).click()
  await expect(first).toContainText('Approved, waiting')
  await page.getByRole('button', { name: 'Remove complaint' }).click()
  await expect(page.getByRole('alert').first()).toContainText('needs the approver role')
  await signInAs(page, 'paul')
  await openCase(page, 'Bank letter please')
  await page.getByLabel('Reason for the class change').fill('the mail only asks for a bank letter')
  await page.getByRole('button', { name: 'Remove complaint' }).click()
  await expect(page.locator('.tag.risk-low').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('reply').filter({ hasText: 'bank_letter_info' })).toBeVisible()
  // approved earlier; the change since then lapses the approval as soon as the new reply is ready, not at the next copy
  const old = page.getByTestId('reply').filter({ has: page.locator('span.tag', { hasText: /^complaint_ack$/ }) })
  await expect(old).toContainText('Out of date')
  await expect(old.getByRole('button', { name: /^Copy|Mark as sent|Approve/ })).toHaveCount(0)
  await expect(page.getByText('Approved, waiting')).toHaveCount(0)
  const id = new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get('case')!
  const audit = (await control(`/audit?case=${id}`)) as Array<{ type: string; detail: boolean }>
  expect(audit.find((a) => a.type === 'case.labels_changed')?.detail).toBe(true)
  expect(audit.map((a) => a.type)).toContain('reply.approval_lapsed')
})

test('TC-REV-09 wording and display (D8): class floor, subject note, monospace address, no rule ids, removed class, no Reject on an out-of-date draft', async ({ page }) => {
  await signInAs(page, 'rita')
  await expect(page.locator('button.row .mono', { hasText: 'amelia@hartfamily.example' }).first()).toBeVisible()
  await openCase(page, 'New bank details')
  await expect(page.getByText('Class floor: bank_details → high')).toBeVisible()
  await expect(page.getByTestId('reply').first()).toContainText("set by the template; the subject of the sender's mail is never repeated")
  // a reviewer cannot lower the risk: the refusal is the plain sentence, without «(C-RSK-3)»
  await page.getByLabel('Set risk').selectOption('low')
  await page.getByRole('button', { name: 'Apply' }).click()
  const alert = page.getByRole('alert').first()
  await expect(alert).toContainText('lowering the risk needs the approver role and a reason')
  await expect(alert).not.toContainText('C-RSK')
  // after E2E-04: complaint was removed by paul with a reason
  await page.goto('/')
  await openCase(page, 'Bank letter please')
  await expect(page.locator('ul.removed')).toContainText('complaint removed by paul: the mail only asks for a bank letter')
  await expect(page.locator('ul.removed s', { hasText: 'complaint' })).toBeVisible()
  const old = page.getByTestId('reply').filter({ has: page.locator('span.tag', { hasText: /^complaint_ack$/ }) })
  await expect(old).toContainText('Out of date')
  await expect(old.getByRole('button', { name: 'Reject' })).toHaveCount(0)
  const actions = page.locator('ul.actions')
  await expect(actions).toHaveText('No action needed')
})

test('TC-REV-10 display (R-REV-02 v0.7.25, 界面规则 v0.3.4): signals fired or folded, two columns from 1024px, one at 375px, room for the select arrow in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signInAs(page, 'rita')
  await openCase(page, 'New bank details')
  // the folded full list and the visible tags tell the same story
  const all = page.locator('details:has(summary:text-matches("^All signals")) ul.signals li')
  const on = await all.evaluateAll((ls) => ls.filter((l) => l.classList.contains('on')).length)
  const unknown = await all.evaluateAll((ls) => ls.filter((l) => l.classList.contains('unknown')).length)
  expect(await all.count()).toBeGreaterThan(0)
  await expect(page.locator('.tag.sig-on')).toHaveCount(on)
  await expect(page.locator('.tag.sig-unknown')).toHaveCount(unknown)
  await expect(page.getByText(/^No warning signals/)).toHaveCount(on === 0 ? 1 : 0)
  await expect(all.first()).toBeHidden()
  // two columns: the mail on the left, risk / links / reply / task on the right
  const main = await page.locator('.case-main').boundingBox()
  const side = await page.locator('.case-side').boundingBox()
  expect(main!.x + main!.width).toBeLessThanOrEqual(side!.x)
  expect(Math.abs(main!.y - side!.y)).toBeLessThan(2)
  for (const h of ['Risk', 'Links', 'Reply', 'Check the bank details request']) await expect(page.locator('.case-side').getByRole('heading', { name: h })).toBeVisible()
  for (const h of ['Message (plain text)', 'Classes']) await expect(page.locator('.case-main').getByRole('heading', { name: h })).toBeVisible()
  // the select arrow keeps its distance from the edge, light and dark
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const pad = await page.getByLabel('Set risk').evaluate((s) => parseFloat(getComputedStyle(s).paddingRight))
    expect(pad, scheme).toBeGreaterThanOrEqual(32)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  // Real nested controls with long directory candidates and a recipient (round-1 F3).
  const candidate = 'Northwind Robotics Secondary Investment Vehicle 2026::001'
  const recipient = 'investment.operations.secondary.vehicle.2026@northwind-robotics-investments.example'
  await page.route('**/api/cases/*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (body.e3?.links) {
      body.e3.links.commitmentCandidates = [candidate]
      body.e3.allowedRecipients = [recipient]
      for (const reply of body.e3.replies) reply.recipient = recipient
    }
    await route.fulfill({ response, json: body })
  })
  await page.reload()
  await expect(page.getByLabel('Choose the commitment').locator('option').last()).toHaveText(candidate)
  await expect(page.getByTestId('reply').first()).toContainText(recipient)
  for (const width of [1024, 375]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `long values at ${width}`).toBeLessThanOrEqual(width)
    const select = await page.getByLabel('Choose the commitment').boundingBox()
    const column = await page.locator('.case-side').boundingBox()
    expect(select!.x + select!.width).toBeLessThanOrEqual(column!.x + column!.width + 1)
  }
  // narrow: one column, signals and risk above the mail, no sideways scroll
  await page.setViewportSize({ width: 375, height: 740 })
  const m = await page.locator('.case-main').boundingBox()
  const s = await page.locator('.case-side').boundingBox()
  expect(s!.y + s!.height).toBeLessThanOrEqual(m!.y + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
})

test('E2E-05 after importing the Toolkit CSV, a new mail is linked automatically', async ({ page }) => {
  await signIn(page) // the admin imports the directory
  const csv = 'investor_id,name,email,reference,cash_due\n001,Amelia Hart,amelia@hartfamily.example,NW-001,"10,000.00"\n002,Ben Okafor,ben@okafor.example,NW-002,"7,500.00"\n'
  const status = await page.evaluate(async (body) => {
    const r = await fetch('/api/directory/commitments?deal=Northwind%20Robotics', { method: 'POST', headers: { 'content-type': 'text/csv', 'x-csrf-token': sessionStorage.getItem('doi.csrf') ?? '' }, body })
    return r.status
  }, csv)
  expect(status).toBe(200)
  await control('/ingest', { from: 'Ben Okafor <ben@okafor.example>', subject: 'Second payment', text: 'Paid my commitment, reference NW-002.' })
  await page.reload()
  await expect(page.getByText('Second payment', { exact: true })).toBeVisible({ timeout: 10_000 })
  await openCase(page, 'Second payment')
  await expect(page.getByText('Ben Okafor · NW-002')).toBeVisible({ timeout: 10_000 })
})

test('TC-REV-05 two tabs: after a sign-out and a new sign-in in one tab, the other tab still works and can sign out (Codex E5 F4)', async ({ browser }) => {
  const context = await browser.newContext()
  const a = await context.newPage()
  await signIn(a)
  const b = await context.newPage()
  await b.goto('/')
  await expect(b.getByRole('heading', { name: 'Cases' })).toBeVisible()
  // tab A signs out and in again: a new session; tab B still holds the old session's token in its own storage
  await a.getByRole('button', { name: 'Sign out' }).click()
  await signIn(a)
  await b.reload()
  await expect(b.getByRole('heading', { name: 'Cases' })).toBeVisible()
  await b.getByRole('button', { name: 'Sign out' }).click()
  await expect(b.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await context.close()
})

