import { describe, expect, it } from 'vitest'
import { caseStatus, displayName, transferText } from './presentation.ts'

describe('TC-DEMO-05 attachment transfer states', () => {
  it('never turns failures, manual handling or pending work into a successful transfer', () => {
    for (const demo of [true, false]) {
      expect(transferText({ state: 'failed', error: 'infected', removed: false }, demo)).toBe('Blocked by the virus scan; not transferred')
      expect(transferText({ state: 'failed', error: 'timeout', removed: false }, demo)).toBe('Transfer failed (timeout)')
      expect(transferText({ state: 'pending', error: null, removed: false }, demo)).toBe('Transfer pending')
      expect(transferText({ state: 'discarded', error: null, removed: true }, demo)).toBe('Blocked by the virus scan; handled manually; removed from this system')
      expect(transferText({ state: 'discarded', error: null, removed: false }, demo)).toBe('Blocked by the virus scan; handled manually')
      expect(transferText({ state: 'delivered', error: null, removed: true }, demo)).toBe('Transferred; removed from this system')
    }
    expect(transferText({ state: 'delivered', error: null, removed: false }, true)).toBe('Recorded transfer: completed')
    expect(transferText({ state: 'delivered', error: null, removed: false }, false)).toBe('Transferred; removal pending')
    expect(transferText({ state: 'new_state', error: null, removed: false }, true)).toBe('Transfer state: new_state')
  })
  it('retains unknown IDs and distinguishes manual send status', () => {
    expect(displayName('future_class')).toBe('future_class')
    expect(caseStatus('sent')).toBe('Marked as sent')
    expect(caseStatus('future_status')).toBe('future_status')
  })
})
