# Data protection impact assessment (DPIA): template

**For the organisation that deploys Deal Ops Inbox** (the controller). The structure follows the usual UK GDPR
DPIA steps.

- Facts about the **software** are filled in. They describe what the software does, as built.
- Everything only you know is marked **[to complete]**: your purposes, your mailboxes, your providers, your risk
  decisions.
- This template gives no view on whether your processing meets any law. That assessment is yours, and your data
  protection officer's or adviser's.

Keep the completed DPIA under review. Revisit it whenever you add a mailbox, change the model provider, change
retention or connect a new outbound target.

---

## 1. Identifying the need for a DPIA

| Question | Answer |
|---|---|
| Organisation (controller) | [to complete] |
| Data protection officer / adviser | [to complete] |
| Owner of this assessment | [to complete] |
| Date and version | [to complete] |
| Why a DPIA is being done | [to complete]. Points you may weigh: the processing is systematic and covers every inbound email to the configured mailboxes; it may include identity documents and financial details; it uses a language model; it flags possible fraud. |

## 2. Description of the processing

### 2.1 Nature: what the software does

Deal Ops Inbox is self-hosted. It runs on infrastructure you control. The project's authors receive no data, and the
software contains no analytics or telemetry.

For each inbound email in the configured mailboxes, the software:

1. Reads the email (read-only) and stores the raw message, encrypted. It never sends email, writes drafts, or moves,
   flags or deletes mail.
2. Scans attachments for viruses, then parses those that passed in a sandbox with no network.
3. Extracts facts with fixed rules: references, amounts, dates, UETRs, payment messages.
4. Decides with fixed code which attachments may be KYC documents. Their content is never sent to any model.
5. Redacts sensitive values (account numbers, sort codes, ID numbers, dates of birth, addresses, phone numbers, email
   local parts, names in the directory) and sends the **redacted** text to the configured language model. The model
   classifies the email and extracts fields. It writes no outbound text and takes no action.
6. Links the email to deals, commitments and contacts in a directory you import.
7. Computes a risk level with fixed rules, for example a changed bank account request, a look-alike domain, a hidden
   text or a prompt-injection marker.
8. Proposes a reply from a fixed template, and a person reviews it. A person copies the approved reply and sends it
   from their own mail client.
9. Creates verification tasks for bank-detail and identity changes. These need two different people and a
   cooling-off period.
10. Transfers possible-KYC attachments to your KYC target, then removes them from its own store.
11. Keeps an append-only, hash-chained audit log with no personal data in the audit rows.
12. Deletes data at the end of the retention periods.

What the software does **not** do:

- it does not send email
- it does not move money or connect to banks
- it does not verify KYC or score AML risk
- it does not profile individuals
- it does not write to business systems
- it does not take decisions about investors (for example refusing a withdrawal); people decide
- it does no OCR.

### 2.2 Scope

| Item | Software facts | Your deployment |
|---|---|---|
| Mailboxes | Any number of IMAP, Gmail, Microsoft 365 or `.eml` mailboxes, each configured by name | [to complete: which mailboxes, whose mail] |
| Data subjects | Senders and recipients of emails; people named in emails and attachments; investors and contacts in your directory; your staff who use the app | [to complete: e.g. investors, their representatives, advisers, counterparties, staff; any children or vulnerable people?] |
| Personal data | Names, email addresses, phone numbers, postal addresses; email contents and attachments; bank account details and payment information in emails; identity documents in attachments (possible-KYC); commitment and ledger amounts from your directory; user accounts and actions of your staff | [to complete] |
| Special category / criminal offence data | The software does not look for these. It may receive them if senders include them. | [to complete: your assessment] |
| Volume | [to complete: emails per month, number of directory entries] | |
| Geography | Where your hosts and providers process data | [to complete] |

### 2.3 Context

| Item | Answer |
|---|---|
| Relationship with data subjects; would they expect this processing? | [to complete] |
| How much control do data subjects have? | [to complete] |
| Prior concerns or incidents | [to complete] |
| Relevant codes, sector guidance, contracts with investors | [to complete] |

### 2.4 Purposes

| Item | Answer |
|---|---|
| Purposes | [to complete: e.g. handling operational emails about investments faster and more consistently; detecting payment-redirection fraud; keeping an audit trail] |
| Lawful basis for each purpose | [to complete; see the [LIA template](lia-template.md) if you rely on legitimate interests] |
| Condition for any special category data | [to complete] |

## 3. Processors and outbound connections

The software connects only to the targets you configure. It has no inbound address of its own: Microsoft 365 uses
polling, and Gmail Pub/Sub uses pull. The parser container has no network at all. The demo mode makes no outbound
connection.

Complete one row per target you enable. Rows you do not enable: write "not used".

| Connection (as built) | Personal data that crosses it | Enabled? | Provider and role (processor / controller) | Contract / agreement | Location and transfer basis |
|---|---|---|---|---|---|
| **IMAP server** (your mail host) | full emails (read) | [to complete] | [to complete] | [to complete] | [to complete] |
| **Gmail API** (`gmail.googleapis.com`) | full emails (read), label ids, the mailbox profile | [to complete] | [to complete] | [to complete] | [to complete] |
| **Google Pub/Sub** (`pubsub.googleapis.com`), optional | notification messages (mailbox address and history id) | [to complete] | [to complete] | [to complete] | [to complete] |
| **Google token endpoint** (`oauth2.googleapis.com`) | OAuth client id and secret, refresh token | [to complete] | [to complete] | [to complete] | [to complete] |
| **Microsoft Graph** (`graph.microsoft.com`) | full emails (read), folder names, the app's own permission records | [to complete] | [to complete] | [to complete] | [to complete] |
| **Microsoft token endpoint** (`login.microsoftonline.com`) | client credentials | [to complete] | [to complete] | [to complete] | [to complete] |
| **Language model provider** (hosted, or a local Ollama) | **redacted** email text and file names; never possible-KYC attachment content | [to complete] | [to complete] | [to complete: the `model.dpa` setting records only your declaration] | [to complete: `model.region`, `model.transfer_basis`] |
| **S3-compatible storage** | encrypted raw emails and attachments | [to complete]. This release stores files on the local `files` volume; S3 is listed in the design for later use. | [to complete] | [to complete] | [to complete] |
| **OIDC identity provider**, optional | staff sign-in (subject id, email or user name, role claim) | [to complete] | [to complete] | [to complete] | [to complete] |
| **Event webhook**, optional | events with a closed list of fields (Case ids, categories, risk, actions, amounts; bank account numbers as the last 4 digits only) | [to complete] | [to complete] | [to complete] | [to complete] |
| **KYC webhook or KYC folder** | possible-KYC attachment files, with Case id and SHA-256 | [to complete] | [to complete] | [to complete] | [to complete] |

Other connections of the standard Compose set-up that carry no email content:

| Connection | What crosses it | Enabled? |
|---|---|---|
| ClamAV virus database updates (the `clamav` container's update service; off in the demo) | no personal data | [to complete] |
| The optional `proxy` (Caddy) obtaining HTTPS certificates | your domain name | [to complete] |
| The Gmail consent page, opened in an operator's browser during `gmail-auth` (not by the server) | the mailbox user's sign-in at Google | [to complete] |

Hosting:

| Item | Answer |
|---|---|
| Who hosts the server, and where | [to complete] |
| Who can access the host, the secrets and the backups | [to complete] |

## 4. Retention

These are the software defaults. You may change the two configurable values.

| Category (as built) | Default | Your period and reason |
|---|---|---|
| All data of one email: message, raw email and attachment files with all stored versions, parse results, the Case with its labels, fields, links, signals, replies and verification tasks, the redaction table, the audit detail, and the Case's event outbox rows | 5 years from the receive time (`retention.messages_days: 1826`) | [to complete] |
| Directory versions no longer referenced by any Case | 5 years from the day they stop being referenced (`retention.directory_days: 1826`) | [to complete] |
| The current directory version of each kind | kept while current | [to complete] |
| Audit rows (no personal data) | kept forever | [to complete] |
| Possible-KYC attachments in the app | deleted once every possible-KYC attachment of the email has been transferred; kept with a daily reminder while a transfer fails | [to complete] |
| Files at your KYC target | outside the software | [to complete] |
| Cases on hold (and earlier Cases in the same thread) | kept until the hold is cleared | [to complete: who may set a hold, and when] |
| Demo data | reset at every demo start | not applicable to production |
| Backups | your backup policy | [to complete] |
| Data at your processors (mail host, model provider, webhook receivers) | their terms | [to complete] |

Details: [Retention](retention.md).

## 5. Consultation

| Who | When | Outcome |
|---|---|---|
| Data protection officer / adviser | [to complete] | [to complete] |
| Information security | [to complete] | [to complete] |
| Operations staff who will use it | [to complete] | [to complete] |
| Processors | [to complete] | [to complete] |
| Data subjects or their representatives (if appropriate) | [to complete] | [to complete] |

## 6. Necessity and proportionality

| Question | Software facts | Your answer |
|---|---|---|
| Does the processing achieve the purpose? Is there a less intrusive way? | — | [to complete] |
| Data minimisation | Only configured mailboxes and labels or folders are read. Sent, drafts, spam and trash are never received from Gmail. The model receives redacted text only, and no possible-KYC content. Events and CSV exports have a fixed list of fields. | [to complete] |
| Accuracy | People review every Case. Model fields need provenance quotes, and invalid values are discarded. Emailed payment confirmations never count as received. Emailed bank details are never applied. | [to complete] |
| Transparency to data subjects | — | [to complete: privacy notice wording] |
| Data subject rights (access, erasure, objection) | The software has no dedicated rights-request feature. Data is encrypted per value. The review UI has no search: it lists Cases with filters by status, queue and risk only. To find a person's Cases, search the Case CSV export (it lists each Case's sender address) and the action CSV export (it lists investor names), then open each Case at `https://<your app>/#case=<case_id>`. This finds only Cases where the person is the sender or the linked investor; Cases where they are only mentioned (in the text, in Cc or in an attachment) cannot be found with this version's tools, so cover them in your own procedure. | [to complete: your procedure] |
| Automated decision-making | The software makes no decision with legal or similarly significant effects. Categories, risk and draft replies are proposals for a person. | [to complete: your assessment] |
| International transfers | The model provider settings record region and transfer basis, and warn when the region is outside the UK / EEA without a basis. | [to complete] |
| Processor terms | The software refuses to start an external model provider without `dpa: true`, unless it is overridden (with a warning). | [to complete] |

## 7. Risks

Assess likelihood and severity for **your** deployment. The software measures listed are what the software does;
they do not decide the residual risk.

| # | Risk to individuals | Software measures | Likelihood | Severity | Residual risk |
|---|---|---|---|---|---|
| R1 | Unauthorised access to emails and identity documents | Encryption at rest of all text and files; roles; read-only root file systems; parser with no network and no secrets; HTTPS-only cookies; CSRF protection; no secrets in logs | [to complete] | [to complete] | [to complete] |
| R2 | Disclosure to the model provider | Redaction before every call; possible-KYC content never sent; start-up refusal without an agreement; option of a local model | [to complete] | [to complete] | [to complete] |
| R3 | A wrong reply sent to a fraudster, or record data disclosed to the wrong person | Fixed templates; record data only for authenticated senders linked to the commitment; bank-detail Cases get `safe_ack` only; a person approves and sends every reply | [to complete] | [to complete] | [to complete] |
| R4 | Payment-redirection fraud succeeds | Emailed bank details never applied; verification task with a call to the number on file, two people and a cooling-off period | [to complete] | [to complete] | [to complete] |
| R5 | A risk flag leaks to the sender ("tipping off") | Risk flags never in outbound text; internal-term checks on templates and final replies | [to complete] | [to complete] | [to complete] |
| R6 | The mailbox is changed or mail is sent by the software | No send capability; request allow-list; CI no-send check; least-permission scopes; Microsoft 365 permission check at every start | [to complete] | [to complete] | [to complete] |
| R7 | Data kept too long | Daily retention deletion with audit; KYC deletion after transfer | [to complete] | [to complete] | [to complete] |
| R8 | Inaccurate classification or fields | Human review; evaluation set; model output cannot lower risk | [to complete] | [to complete] | [to complete] |
| R9 | IMAP credentials could also send mail | Read-only commands; documented request to disable SMTP | [to complete] | [to complete] | [to complete] |
| R10 | One person controls all admin accounts or the identity provider and bypasses two-person checks | Account-history checks on verification tasks (software checks cannot stop a single controller of every account) | [to complete] | [to complete] | [to complete] |
| R11 | [to complete: other risks] | | | | |

## 8. Measures to reduce risk

| Risk | Your additional measures | Effect | Approved by |
|---|---|---|---|
| [to complete] | [to complete: e.g. disable SMTP on the IMAP account; signed processor terms; host hardening; backup encryption; staff training; privacy notice] | [to complete] | [to complete] |

## 9. Sign-off

| Item | Name / date | Notes |
|---|---|---|
| Measures approved by | [to complete] | |
| Residual risks approved by | [to complete] | If a high risk remains, consider prior consultation with the regulator. |
| DPO / adviser advice | [to complete] | |
| Advice accepted or overruled (with reasons) | [to complete] | |
| Next review date | [to complete] | |
