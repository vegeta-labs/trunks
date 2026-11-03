import { describe, expect, it } from 'vitest'
import { withoutRuleIds } from './api.ts'

describe('error texts shown to people (D8)', () => {
  it('TC-REV-09 rule ids are left out of error texts; the sentence stays', () => {
    expect(withoutRuleIds('lowering the risk needs the approver role and a reason (C-RSK-3)')).toBe('lowering the risk needs the approver role and a reason')
    expect(withoutRuleIds('the text of safe_ack cannot be changed (C-DRF-7)')).toBe('the text of safe_ack cannot be changed')
    expect(withoutRuleIds('copy failed (R-REV-04 v0.7.20)')).toBe('copy failed')
    expect(withoutRuleIds('not a matched reference (C-EXT-2)')).toBe('not a matched reference')
    expect(withoutRuleIds('a rule label cannot be removed (C-CLS-5)')).toBe('a rule label cannot be removed')
    expect(withoutRuleIds('wrong current password, or the new one is too short (12+) or unchanged')).toBe('wrong current password, or the new one is too short (12+) or unchanged')
    expect(withoutRuleIds('the task is open')).toBe('the task is open')
  })
})
