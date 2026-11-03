// Mailbox adapter interface (tech design §3.1). Read-only by construction: there is no write or send method
// (PRD decision 5); the no-send check (TC-OUT-09) fails CI if this interface gains a member.

export interface MessageRef {
  mailboxId: string
  key: string // provider id: IMAP `uidvalidity:uid`, `.eml` file hash, …
}

export interface MailboxAdapter {
  id: string // internal id (does not change when the mailbox is renamed)
  name: string // configured mailbox name
  capabilities: { push: boolean; trustedAuthResults: boolean }
  start(onMessage: (ref: MessageRef) => Promise<void>): Promise<void>
  catchUp(cursor: string | null): Promise<{ refs: MessageRef[]; cursor: string; resync?: boolean }>
  fetchRaw(ref: MessageRef): Promise<{ raw: Buffer; serverReceivedAt: string } | { gone: true }>
  renew(): Promise<void>
}
