# Legitimate interests assessment (LIA): template

**For the organisation that deploys Deal Ops Inbox**, if it relies on legitimate interests (UK GDPR Article 6(1)(f))
for some or all of the processing. The structure follows the three-part test: purpose, necessity and balancing.

- Facts about the **software** are filled in.
- What only you know is marked **[to complete]**.
- This template does not decide whether legitimate interests is the right basis, or whether the test is met. That is
  your assessment.

Use it together with the [DPIA template](dpia-template.md). The processing description, the list of connections and
the retention table there apply here too.

---

## 0. Details

| Item | Answer |
|---|---|
| Organisation (controller) | [to complete] |
| Processing covered | [to complete: e.g. automated triage, fact extraction, linking and fraud flagging of emails to the operations mailboxes listed in the DPIA] |
| Other lawful bases considered (contract, legal obligation) and why they do or do not fit | [to complete] |
| Assessor, date, version | [to complete] |

## 1. Purpose test: is there a legitimate interest?

| Question | Answer |
|---|---|
| What is the interest? | [to complete: e.g. handling investor operations email accurately and quickly; preventing payment-redirection and impersonation fraud; keeping a verifiable record of how each email was handled] |
| Whose interest is it: yours, a third party's, the data subjects'? | [to complete: e.g. investors also benefit from fraud checks on bank-detail changes] |
| What would happen without the processing? | [to complete] |
| Is the interest lawful and clearly stated? | [to complete] |
| Any ethical issues? | [to complete] |

## 2. Necessity test: is the processing needed for that purpose?

| Question | Software facts | Your answer |
|---|---|---|
| Does the processing actually help? | It classifies, extracts, links and flags risk, and prepares template replies. A person reviews and decides. | [to complete] |
| Is there a less intrusive way? | Configurable: only chosen mailboxes and labels or folders; a local model instead of a hosted one; shorter retention; no event webhook | [to complete] |
| Is only the data needed processed? | The model receives redacted text only. Possible-KYC attachment content goes to no model. Exports and events carry a fixed list of fields, and bank accounts as the last four digits. Images and scans are never read (no OCR). | [to complete] |
| How long is data kept? | Defaults: 5 years per email from receipt; KYC attachments removed from the app after transfer; audit rows (no personal data) kept. See the DPIA, section 4. | [to complete] |

### 2.1 Connections and retention covered by this assessment

Mark each outbound connection the deployment uses. Details are in the DPIA, section 3.

| Connection (as built) | Used? |
|---|---|
| IMAP server | [to complete] |
| Gmail API (`gmail.googleapis.com`) | [to complete] |
| Google Pub/Sub (`pubsub.googleapis.com`) | [to complete] |
| Google token endpoint (`oauth2.googleapis.com`) | [to complete] |
| Microsoft Graph (`graph.microsoft.com`) | [to complete] |
| Microsoft token endpoint (`login.microsoftonline.com`) | [to complete] |
| Language model provider (redacted text only) | [to complete] |
| S3-compatible storage (listed in the design; this release stores files on the local volume) | [to complete] |
| OIDC identity provider | [to complete] |
| Event webhook | [to complete] |
| KYC webhook or KYC folder | [to complete] |

Retention categories (software defaults; details in the DPIA, section 4):

| Category | Default | Your period |
|---|---|---|
| All data of one email (message, raw email and attachment files with all versions, parse results, the Case with labels, fields, links, signals, replies and verification tasks, redaction table, audit detail, event outbox rows) | 5 years from receipt | [to complete] |
| Directory versions no longer referenced | 5 years from the day they stop being referenced | [to complete] |
| Current directory version | kept while current | [to complete] |
| Audit rows (no personal data) | kept forever | [to complete] |
| Possible-KYC attachments in the app | deleted after successful transfer; kept with daily reminders while a transfer fails | [to complete] |
| Cases on hold and earlier Cases in their thread | kept until the hold is cleared | [to complete] |
| Demo data | reset at every demo start | not applicable |
| Backups | your backup policy | [to complete] |

## 3. Balancing test: do the individuals' interests override yours?

### 3.1 Nature of the data

| Question | Software facts | Your answer |
|---|---|---|
| What kinds of personal data? | Email contents and attachments, contact details, bank and payment details, identity documents in attachments, directory data (commitments, ledger) | [to complete] |
| Special category or criminal offence data? | Not sought; may arrive in emails | [to complete] |
| Data about children or vulnerable people? | Not sought | [to complete] |

### 3.2 Reasonable expectations

| Question | Answer |
|---|---|
| Relationship with the individuals | [to complete] |
| What have you told them (privacy notice, investor documents)? | [to complete] |
| Would they expect their emails to be triaged by software and screened for fraud? | [to complete] |
| Would they expect redacted text to go to a model provider? | [to complete] |

### 3.3 Likely impact

| Question | Software facts | Your answer |
|---|---|---|
| Possible impact on individuals | The software makes no decisions. Every reply, risk change and verification is done by people. A risk flag may lead to a verification call. | [to complete] |
| Could a flag harm someone (for example a wrongly flagged genuine change)? | Risk flags never appear in outbound text. Look-alike detection only raises risk and never blocks. A person reviews every Case. | [to complete] |
| Loss of control over their data? | Self-hosted; no data to the software's authors; outbound connections only to the targets you configure | [to complete] |
| Can individuals object? How is that handled? | The software has no dedicated objection feature | [to complete: your procedure] |

### 3.4 Safeguards

These are the measures as built. Add your own.

- Read-only mailboxes; no send capability; least-permission mailbox access.
- Redaction before every model call; possible-KYC content never sent to a model; start-up refusal for an external
  model without a data processing agreement (unless overridden, with a warning).
- Encryption at rest of all text and files; role separation in the database; append-only audit chain without personal
  data.
- Fixed templates; no model-written outbound text.
- Emailed bank details never applied; emailed payment confirmations never count as received.
- Retention deletion, with a hold flag for disputes.
- Your additional safeguards: [to complete]

## 4. Outcome

| Item | Answer |
|---|---|
| Can you rely on legitimate interests for this processing? | [to complete] |
| Reasons | [to complete] |
| Conditions, or changes to the processing | [to complete] |
| Privacy notice updated? | [to complete] |
| Decision by, date | [to complete] |
| Next review | [to complete] |
