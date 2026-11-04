# Changelog

## v0.2.0 (2026-11-04): safer attachment handling and clearer review workflows

- **Inline images:** a narrow, configurable signature-image exception uses strict MIME/HTML and PNG/JPEG/GIF structural checks. Defaults: 400 pixels on the long side, 150 on the short side and 51,200 bytes; hard caps: 1280/300 pixels and 102,400 bytes. Images are never decoded for OCR or sent to a model. An identity image reduced to the qualifying limits, or data encoded in permitted metadata, can remain in the archive instead of being transferred; see the DPIA/LIA templates.
- **KYC:** decisions and transfer jobs are saved before model classification. Stricter decisions retry durably and can trigger later archive-replacement rounds. Legacy MIME identities, oversized archive fallback, transfer hashes and recorded-copy recovery are checked before deletion.
- **Verification:** all approval blockers are explained. An approver/admin can restart an open or checklist-done task with a reason; the same task generator supplies the new checklist, contact details and cooling-off period, with an audit record.
- **Review UI and templates:** Cc, escaped/masked hidden-text evidence, low-confidence risk floors, invalid-IBAN hints, persistent refusal notices and Case hash navigation; deployment sign-off and clearer payment-reference wording.
- **Data protection:** fixed failure codes at job/log boundaries, CID HMAC/disposition enums, and message-wide sensitivity propagation in derived hidden evidence.
- **Classification:** versioned prompt guidance distinguishes a missing business fact from a detail that an email did not supply. Relevant but uncertain evidence can still produce a low-confidence label, and multiple business purposes remain supported; adoption, risk and reply rules are unchanged.

### Independent held-out evaluation

A newly written **held-out set of 121 emails**, unseen by development, was run once by an independent runner with a real model (**Claude Opus 5.5**, response model `claude-opus-5-5`). All 121 emails were processed with no model fallbacks or errors; 232 requests received 232 successful responses. Every gated metric passed:

| Metric | Threshold | Result |
|---|---|---|
| Classification, macro F1 (¹) | ≥ 0.85 | 0.965 |
| Fields extracted by rules | 100% | 100% (121/121) |
| Field recall | ≥ 0.90 | 93.1% (326/350) |
| Field precision | ≥ 0.90 | 95.2% (320/336) |
| Fields that should stay empty | ≥ 0.95 | 100% (36/36) |
| Contact, commitment and deal all linked correctly, samples with one unambiguous answer | ≥ 0.95 | 99.2% (119/120) |
| Risk never underestimated | 100% | 100% (121/121) |
| High-risk emails rated high | 100% | 100% (79/79) |
| Emails annotated as malicious bank-detail changes or look-alike senders rated high | 100% | 100% (25/25) |
| Replies never disclose more than allowed | 100% | 100% (121/121) |
| Prompt injection does not change the judgement (vs. a clean twin) | 100% | 100% (15/15) |
| Risk and template from the rules, given the annotated categories and fields | 100% | 100% (121/121) |
| Rule consistency against the independent implementation, using actual inputs | 100% | 100% (121/121) |

(¹) Over the categories whose risk floor is not high, excluding `unclassified` and categories with no example. Macro F1 rounded to six decimal places is 0.964884 across 10 eligible categories. High-risk categories are measured by the risk rows. Reported without a threshold: exact end-to-end risk 99.2% (120/121), exact end-to-end reply template 95.9% (116/121). A person still reviews every Case and reply.

The initial prerelease attempt failed injection invariance at 14/15; that result remains FAIL. After the classification repair, the result above was measured on a completely new independent set, with no old recordings reused. The consumed sets do not supply future release evidence; private development regression results are not reported as new holdout measurements.

### Scope and limits

Development evaluation on 199 fictional emails, independent oracle checks, unit/integration/browser checks and the read-only static demo were validated. Existing v0.1.0 limitations remain except for the narrow inline-image exception above. Microsoft 365 and Gmail push notifications (Pub/Sub) were tested only against simulated services. Gmail polling was tested on one personal Gmail account. The startup timing in the historical v0.1.0 section is that version's cached-image measurement; no new clean-machine timing or production-mail-volume test claim is added.

## v0.1.1 (2026-11-03): clearer demo and review UI

- **Static demo:** a compact read-only bar with the snapshot version and an “About this demo” fold; change
  controls and account information are hidden. Every Reply panel, including cases without a draft, explains
  that the app cannot send. Case contents and verification information remain readable.
- **Review UI:** warning and unchecked signals stay visible, with the full list folded. Case details use two
  columns from 1024px and one column on narrow screens; long candidates and recipient addresses fit at
  1024px and 375px. Select arrows have room in both light and dark themes.
- **Directory imports (D9):** header-only files are rejected without replacing the current directory. Clearing
  requires an explicit `clear=yes` request. An explicitly cleared ledger is treated as no ledger imported;
  existing ledgers retain their previous meaning.
- **Validation:** development evaluation on recorded model replies passed; unit, integration, browser,
  parser, Compose and coverage checks passed in CI. All 11 review-UI mutation checks were caught.

**Evaluation:** the v0.1.0 holdout result applies (measured on v0.1.0; judgement code unchanged except D9,
which acts only on header-only lists or `clear=yes`). The unchanged metric values are the table in the
v0.1.0 section below. The independent runner confirmed that the held-out run met neither D9 condition.
This release does not report a new holdout measurement. Version metadata, release/test tooling and
UI/documentation changes do not alter the evaluation inputs, model or judgement pipeline; the PRD field
table and evaluation thresholds are unchanged. Other changes require a newly written holdout under G3.

The v0.1.0 limitations below still apply, including simulated Microsoft 365 and Gmail push tests and the
single-account Gmail polling test. No real-production-volume or clean-machine start-up claim is added.

## v0.1.0 (2026-11-03): first public release

Deal Ops Inbox is a self-hosted, **read-only** email agent for investment-operations inboxes. For each inbound email
it picks categories, extracts the key facts, links the email to your directory, flags risk, prepares a reply from a
fixed template for a person to check, copy and send, and routes the email to a queue. It never sends email, never
writes to a mailbox, never moves money and never changes business records.

This list names only what has been built **and tested**. Where a part was tested only in a limited way, it says so.

### What it does

- **Mailboxes, read-only:** IMAP (opened read-only), `.eml` import, Gmail (`gmail.readonly`, one consent per mailbox),
  Microsoft 365 (`Mail.Read` on named mailboxes, permission check at every start). No code path can send or write
  mail; a CI check blocks mail-write calls.
- **Rules first, model second:** amounts, dates, payment references, UETRs, IBANs and UK account numbers,
  MT103 and pacs.008 payment messages are read by code. A language model only picks categories and extracts fields,
  as validated JSON, with no tools. Everything sent to a model is redacted first; attachments that may be identity
  documents never go to any model.
- **Models:** Anthropic Claude, or a local model through Ollama. By default a hosted provider refuses to start
  until the operator records that a data processing agreement exists (`dpa: true`, the operator's own declaration);
  an explicit override (`allow_without_dpa: true`) starts it with a warning in the log and the review UI.
- **Fraud rules fixed in code:** bank details from an email are never applied; an emailed payment confirmation
  never counts as received; risk wording never appears in replies. Bank-detail and identity changes create a
  verification task: call the phone number on file, a cooling-off period, approval by a second person.
- **Replies from fixed templates only:** the template is chosen by code; record data is disclosed only to an
  authenticated sender who is entitled to see it.
- **Directory:** deals, commitments, bank lines and the reconciliation ledger from Deal Ops Toolkit CSV files, plus a
  contacts file.
- **Review UI:** plain-text email view, signals, risk with reasons, replies to approve and copy, verification tasks,
  CSV exports, JSON events to a signed webhook.
- **Data protection:** every text value in the database is encrypted; a hash-chained audit log; retention periods
  per category; possible-KYC attachments transferred to your own folder or webhook and then removed; master key
  rotation; DPIA and LIA templates.
- **Packaging:** Docker Compose with separate containers for the app, maintenance, the database, the virus scanner
  and a sandboxed attachment parser (its own seccomp and AppArmor profiles); a local demo with fictional data and no
  outbound connections.

### How it was tested

- Unit, integration and browser tests; an independent Python implementation of the rules, written only from the
  requirements, compared with the code; mutation checks; the Docker Compose stack started, backed up and restored in CI
  (and upgraded from the previous internal version, in the development repository); the documented user and directory commands run exactly as written in CI.
- An evaluation set of fictional emails written by independent agents that saw only the requirements: a
  development set of 178 emails (run on recorded model replies in CI) and a separate held-out set of 121 emails that
  development never read.
- **Held-out set, real model (Claude Opus 5.5), run once for this release by an independent runner** (121 emails,
  all processed, no model fallbacks). Every gated metric met its threshold:

  | Metric | Threshold | Result |
  |---|---|---|
  | Classification, macro F1 (¹) | ≥ 0.85 | 0.946 |
  | Fields extracted by rules | 100% | 100% (121/121) |
  | Field recall | ≥ 0.90 | 93.6% |
  | Field precision | ≥ 0.90 | 91.9% |
  | Fields that should stay empty | ≥ 0.95 | 96.9% |
  | Contact, commitment and deal all linked correctly, samples with one unambiguous answer | ≥ 0.95 | 100% (120/120) |
  | Risk never underestimated | 100% | 100% (121/121) |
  | High-risk emails rated high | 100% | 100% (57/57) |
  | Emails annotated as malicious bank-detail changes or look-alike senders rated high | 100% | 100% (12/12) |
  | Replies never disclose more than allowed | 100% | 100% (121/121) |
  | Prompt injection does not change the judgement (vs. a clean twin) | 100% | 100% (7/7) |
  | Risk and template from the rules, given the annotated categories and fields | 100% | 100% |

  (¹) Over the categories whose risk floor is not high, without `unclassified` and without categories that have no
  example in the set. Emails in the high-risk categories (for example bank details and identity changes) are measured
  by the risk rows instead (risk never underestimated, high-risk emails rated high).

  Reported without a threshold (end to end, with the model's own categories): risk exactly as annotated 94.2%,
  reply template exactly as annotated 86.0%. A person reviews every Case and reply. The held-out set is now used
  up; the next release is measured on a newly written one.

### Limits of this release

- **Microsoft 365 and Gmail push notifications (Pub/Sub)** were tested only against simulated services. Gmail
  polling was tested on one personal Gmail account. Test with your own tenant before going live.
- **Demo start-up time:** measured at about 2 minutes on a machine that already had the images and base images
  cached (macOS, Docker Desktop). A first start on a clean machine also downloads the base images and was not
  measured.
- **No screens for users and the directory:** an admin uses the HTTP API with `curl`
  (see `docs/en/users-and-directory.md`).
- Inline signature images count as possible identity documents; there is no OCR; the AppArmor profile needs
  AppArmor 4 (for example Ubuntu 24.04); macOS runs the parser without AppArmor. See `docs/en/security-model.md` §8.
- Not tested with real production mail volumes.

Licence: Apache-2.0.
