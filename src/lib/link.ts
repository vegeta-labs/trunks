// PRD C-LNK-1, 2 (v0.7.12), 4, 5, 6: linking a mail to the directory snapshot of its Case. Pure functions over the
// decrypted snapshot; never changes any directory or ledger state (C-LNK-4 «只显示，不改任何状态»).
import { contactsForAddress } from './signals.ts'
import { matchReferences } from './references.ts'

export interface DirContact {
  contactId: string
  emails: string[]
  role: string
  deals: string[] // deal names
  investorIds: string[] // commitment keys `deal::investor_id`
  authorisedFor: string[]
}
export interface DirDeal {
  dealKey: string
  name: string
  currency: string
  closeDate: string | null
}
export interface DirCommitment {
  dealKey: string
  investorId: string
  keyHmac: string
  name: string
  reference: string
  cashDue: number
}
export interface DirBankLine {
  dealKey: string
  transactionId: string
  date: string
  amount: number
  reference: string | null
}
export interface DirLedgerLine {
  dealKey: string
  transactionId: string | null
  status: string
  commitmentKeyHmac: string | null
  currency: string
  amount: number
}
export interface Dir {
  deals: DirDeal[]
  contacts: DirContact[]
  commitments: DirCommitment[]
  bankLines: DirBankLine[]
  ledger: DirLedgerLine[]
  ledgerDeals: string[]
}

/** The commitment key `deal name::investor_id` (C-DIR-1). */
export const commitmentKey = (dir: Pick<Dir, 'deals'>, c: Pick<DirCommitment, 'dealKey' | 'investorId'>) => `${dir.deals.find((d) => d.dealKey === c.dealKey)?.name ?? c.dealKey}::${c.investorId}`

export interface LinkInput {
  fromAddress: string | null
  references: readonly string[] // C-EXT-2 matches against the snapshot's references
  deal: string | null // the model's `deal` field when valid (§5.5a), as a deal name
  amounts: ReadonlyArray<{ minor: number; currency: string }> // amounts in the mail (C-LNK-4)
  paymentDate: string | null // the mail's payment date (C-DRF-4 source order); null when unknown
  commitment?: string | null // a person's commitment link (key, or null for none) instead of C-LNK-2
}

export interface Links {
  contact: { id: string | null; candidates: string[] }
  commitment: { key: string | null; candidates: string[]; by: 'reference' | 'sender' | null }
  deal: { name: string | null; candidates: string[]; conflict: boolean }
  bankLines: Array<{ transactionId: string; ledgerStatus: string | null }>
}

const DAY = 86_400_000
const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY

export function link(dir: Dir, i: LinkInput): Links {
  const key = (c: DirCommitment) => commitmentKey(dir, c)
  // C-LNK-1
  const matched = i.fromAddress ? contactsForAddress(i.fromAddress, dir.contacts.map((c) => ({ ...c, name: '' }))) : []
  const contact = matched.length === 1 ? dir.contacts.find((c) => c.contactId === matched[0]!.contactId)! : null
  const contactOut = { id: contact?.contactId ?? null, candidates: matched.length > 1 ? matched.map((c) => c.contactId) : [] }

  // C-LNK-2 (v0.7.12)
  const refs = new Set(i.references)
  const byRef = dir.commitments.filter((c) => refs.has(c.reference))
  let commitment: DirCommitment | null = null
  let by: Links['commitment']['by'] = null
  let commitmentCandidates: string[] = []
  if (i.commitment !== undefined) {
    commitment = i.commitment === null ? null : (dir.commitments.find((c) => key(c) === i.commitment) ?? null)
  } else if (byRef.length === 1) {
    commitment = byRef[0]!
    by = 'reference'
  } else if (contact) {
    const own = dir.commitments.filter((c) => contact.investorIds.includes(key(c)))
    if (own.length === 1) {
      commitment = own[0]!
      by = 'sender'
    } else commitmentCandidates = own.map(key)
  }

  // C-LNK-6
  const dealOf = (dealKey: string) => dir.deals.find((d) => d.dealKey === dealKey)?.name ?? null
  const dealExists = (name: string | null) => name !== null && dir.deals.some((d) => d.name === name)
  const senderDeals = [...new Set(matched.flatMap((m) => dir.contacts.find((c) => c.contactId === m.contactId)!.deals))].filter((n) => dealExists(n))
  let deal: Links['deal'] = { name: null, candidates: [], conflict: false }
  if (commitment) deal = { name: dealOf(commitment.dealKey), candidates: [], conflict: i.deal !== null && i.deal !== dealOf(commitment.dealKey) }
  else if (dealExists(i.deal) && (matched.length === 0 || senderDeals.includes(i.deal!))) deal = { name: i.deal, candidates: [], conflict: false }
  else if (contact && senderDeals.length === 1) deal = { name: senderDeals[0]!, candidates: [], conflict: false }
  else deal = { name: null, candidates: senderDeals, conflict: false }

  // C-LNK-4: shown, never changes any status
  const bankLines: Links['bankLines'] = []
  if (commitment) {
    const currency = dir.deals.find((d) => d.dealKey === commitment.dealKey)?.currency
    for (const l of dir.bankLines.filter((b) => b.dealKey === commitment.dealKey)) {
      const byAmount = i.paymentDate !== null && i.amounts.some((a) => a.currency === currency && a.minor === l.amount) && daysApart(l.date, i.paymentDate) <= 5
      const byReference = l.reference !== null && matchReferences(l.reference, [commitment.reference]).length > 0
      if (byAmount || byReference) {
        const led = dir.ledger.find((x) => x.dealKey === l.dealKey && x.transactionId !== null && x.transactionId === l.transactionId)
        bankLines.push({ transactionId: l.transactionId, ledgerStatus: led?.status ?? null })
      }
    }
  }

  return { contact: contactOut, commitment: { key: commitment ? key(commitment) : null, candidates: commitmentCandidates, by }, deal, bankLines }
}

/** C-LNK-5: whether a template that discloses directory or ledger data may be used. */
export function mayDisclose(authenticatedSender: boolean, commitmentKeyLinked: string | null, contact: Pick<DirContact, 'investorIds' | 'authorisedFor'> | null): boolean {
  if (!authenticatedSender || !commitmentKeyLinked || !contact) return false
  return contact.investorIds.includes(commitmentKeyLinked) || contact.authorisedFor.includes(commitmentKeyLinked)
}

export type LedgerState = 'received' | 'not_received' | 'unknown'

/** C-DRF-6: received in full by the snapshot's ledger of that deal. */
export function ledgerState(dir: Pick<Dir, 'deals' | 'commitments' | 'ledger' | 'ledgerDeals'>, key: string): { state: LedgerState; received: number; due: number } | null {
  const c = dir.commitments.find((x) => commitmentKey(dir, x) === key)
  if (!c) return null
  if (!dir.ledgerDeals.includes(c.dealKey)) return { state: 'unknown', received: 0, due: c.cashDue }
  const currency = dir.deals.find((d) => d.dealKey === c.dealKey)?.currency
  const received = dir.ledger
    .filter((l) => l.dealKey === c.dealKey && (l.status === 'auto' || l.status === 'confirmed') && l.commitmentKeyHmac === c.keyHmac && l.currency === currency)
    .reduce((s, l) => s + l.amount, 0)
  return { state: received >= c.cashDue ? 'received' : 'not_received', received, due: c.cashDue }
}
