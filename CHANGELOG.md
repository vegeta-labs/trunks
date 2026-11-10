# Changelog

## v0.4.0 (2026-11-10): closing rules and two-person checks

### Before you upgrade

New images and migration `009_fraud_gates.sql` (`migrate` applies it before `app` starts; it only goes forward). No configuration change is needed. At the first start of v0.4.0:

- Every approved reply that was not marked as sent goes back to draft, and its case goes back to open unless it is closed. Approve these replies again.
- For a reply from before the upgrade, everyone who created any reply on that case counts as an editor, so it needs an approver or admin who is none of them.
- Every verification task from before the upgrade is cancelled, approved ones included. An open case that had finished processing is processed again and gets a new task: do the checklist, cooling-off and second-person approval again. On a closed case the task is not replaced.
- A `bank_details` or `identity_change` class removed before the upgrade counts again, and the case gets a new task, unless it was removed with a reason by someone who is still an approver or admin and whose role has not changed since.
- If one case fails in this startup step, it is recorded in the audit log and startup continues; that case cannot be closed normally until it is reprocessed.

Operators: see `docs/en/use/limits-and-help.md`, "After an upgrade to v0.4.0".

### What changed

- **Verification no longer disappears on its own:** once a case has taken `bank_details` or `identity_change`, the class stays through re-runs and relinks. Only an approver or admin can remove it, with a reason; the removal is recorded and lasts through reprocessing. Labels set by the fixed rules cannot be removed.
- **A changed field invalidates the check:** a verification task records the values of the fields it depends on. When a re-run or a KYC attachment replacement changes one of them, the task is cancelled with an audit entry and a new task is made. Clicking **Confirm** on an unchanged value keeps the task (it no longer resets a finished check).
- **Closing a case:** a normal close needs finished processing, an approved and still valid verification task where one is required, and no approved reply that is not marked as sent. Otherwise only an approver or admin can close, with a reason. Closing cancels approved replies and unfinished tasks; a closed case refuses every change except a retention hold, and background stages finish without writing risk, drafts, tasks or events. There is no reopen in this version.
- **Look-alike senders:** when the sender's display name or domain imitates a known contact, the reply has no recipient and cannot be approved. An approver or admin can allow replying to the original address, with a reason, if the alert is wrong.
- **Edited replies:** a reply whose text differs from its template needs an approver or admin who did not edit it and has no account relationship with an editor (created the account, granted a role, reset a password). Switching templates is not an edit; restoring the template text restores the normal approval.
- **Checked again at every step:** approve, copy and mark as sent run the same checks against the recorded approver. A reply that fails goes back to draft.
- **Inbox:** the case list shows 50 cases a page with **Previous** / **Next** and "Showing 1–50 of N cases"; `GET /api/cases` now also returns `total`. Menus and warnings load right after sign-in, without a reload. Internal rule codes and identifiers on the case page are replaced by plain names; the risk banner no longer flashes during reprocessing.
- **Editing yes/no and list fields:** on the case page, **Edit** on a yes/no field such as Change requested offers **Yes**, **No** or **No value**, and on a list field such as Document types or Details to change it offers one box per allowed value. These fields could not be saved from the page before. The server's checks are unchanged.
- **Operator guide:** `docs/en/use/` is a new step-by-step guide for reviewers and approvers: reading a case, risk and verification, checking a reply, roles, limits and help.

### Testing

No new blind evaluation was run for this release (owner decision D5 in the plan): the evaluation scores classification, risk and reply template once per email, and this release does not change those; it changes what people can do afterwards (closing, removing classes, recipients, approvals), which the evaluation does not measure. Instead:

- Unit, integration and browser tests for every new rule (test plan TC-FRD-13–28, TC-DRF-22–28, TC-REV-14–18), including the real migration and the startup step.
- The independent Python oracle is updated for the new recipient rule; its self-check and the rule-consistency comparison on the development set pass.
- Development set on recorded model replies: unchanged and passing.
- Mutation testing on the changed files of each pull request. The full mutation run now runs weekly in this repository (`.github/workflows/mutation-weekly.yml`) and does not block releases.
- Review: a fresh reviewer and Codex in every round. The inbox fixes had one plan round and one code round (code: both READY); the closing and two-person rules had two plan rounds and two code rounds; the operator guide had one round. Every finding was judged and recorded.

### Evaluation carried forward from v0.3.0

The following held-out results were **measured on v0.3.0** (frozen code `bbdfc8b`, 126 emails, Claude Opus 5.5) and are quoted unchanged under the rule for small versions; they are not a new measurement. The judgement-related files that differ from `bbdfc8b`, each checked against what the evaluation scores, cover: closing, class removal, recipients, verification tasks, the startup step and the server, none of which the evaluation scores; the evaluation scoring fix already used for the v0.3.0 figures; a field-type table moved to its own file unchanged; oracle additions for the recipient rule; and the version number. The development set on recorded model replies gives byte-identical output on `bbdfc8b` and on this release.

| Metric | Threshold | Result |
|---|---|---|
| Classification, macro F1 | ≥ 0.85 | 0.960 |
| Fields extracted by rules (re-scored after the v0.3.0 scoring fix) | 100% | 100% (126/126) |
| Field recall | ≥ 0.90 | 90.0% (442/491) |
| Field precision | ≥ 0.90 | 97.1% (440/453) |
| Fields that should stay empty | ≥ 0.95 | 100% (26/26) |
| Contact, commitment and deal linked correctly | ≥ 0.95 | 98.4% (123/125) |
| Risk never underestimated | 100% | 100% (126/126) |
| High-risk emails rated high | 100% | 100% (80/80) |
| Malicious bank-detail changes or look-alike senders rated high | 100% | 100% (18/18) |
| Replies never disclose more than allowed | 100% | 100% (126/126) |
| Prompt injection does not change the judgement (vs. a clean twin) | 100% | 100% (15/15) |
| Risk and template from the rules, given the annotated categories and fields | 100% | 100% (126/126) |
| Rule consistency against the independent implementation | 100% | 100% (126/126) |
| Real-model cancellations of an otherwise qualifying payment message (reported, no threshold) | — | 2 of 10 |

### Known limits

- Tasks from before the upgrade are bound to field values only after their case is reprocessed.
- A case that was mid-processing at the upgrade gets no new task until it is reprocessed.
- While you page through the list, a case that changes can be skipped or shown twice; reload to correct it.
- A small team with one approver cannot approve that approver's own edited reply: restore the template text, or ask an admin.

## v0.3.0 (2026-11-09): accounts in payment messages

- **Fix, narrow scope:** the payer and beneficiary accounts in an MT103 or pacs.008 attachment no longer count as a bank details change, **only** when the attachment is a structurally valid plain text MT103 or XML pacs.008, the deal has `receiving_accounts` configured and the beneficiary is on it, the sender is authenticated and in one deal, there is no other attachment, the mail has no account or redirect wording, and the model gives only payment classes. Everything else keeps the previous `safe_ack` and verification task, including **a bank's printed PDF, an MT103 pasted into the body**, a deal without `receiving_accounts`, an unauthenticated sender and an investor in several deals. Details and limits: `docs/en/payment-messages.md`.
- **False alarms remain by design:** when the model adds another class to an otherwise qualifying message, the exception is cancelled and the reply stays `safe_ack`. On the development set this happened for 1 of 20 qualifying messages; on the blind set, 2 of 10.
- **Raised safeguards:** a beneficiary account that is not on the linked deal's list now gives high risk, `bank_details` and a verification task, and the label stays through re-runs and relinks. With an MT103 or pacs.008 amount in the mail, change wording in the subject and phrases such as "from now on" add `bank_details` too.
- **No second request for a confirmation:** after five working days, or with no ledger, a single qualifying message with a valid UETR per payment, one value date, the deal's currency and an amount within the commitment gives `payment_evidence_received` and the action `check_payment_evidence`, instead of asking for the MT103 again. A deployment without that template keeps `payment_need_evidence`.
- **Masking:** account values in MT103 party fields and pacs.008 account elements with six or more digits are masked before any model call, whatever their shape, for mail parsed after the upgrade.
- **Directory:** `deals.csv` takes an optional `receiving_accounts` column; only a keyed hash and the last four characters are stored. Migration `008_f1.sql`.
- **Coverage note:** in both blind sets the qualifying samples were pacs.008; qualifying MT103 messages are covered by the development set and the pipeline tests only.
- **Known issue:** the rule-extracted amount list can hold the same amount twice in some mails; comparisons treat it as a set.
- **Known issue:** the field extraction prompt still describes `party_role` as the person who signs; for `bank_details` the settled meaning is the account holder (the deal's SPV is `other`, the investor's own account `investor`). Planned for the next version, as it needs a new prompt version and new recordings.

### Blind evaluation

Measured on frozen code `bbdfc8b` with Claude Opus 5.5, on a new held-out set of 126 emails written and annotation-reviewed by independent agents (one run, 246 model requests, 0 errors or fallbacks). The first scoring failed only "fields extracted by rules": the scorer compared amount objects as JSON text, so `{currency, minor}` and `{minor, currency}` differed. The owner decided 「修评分，重算」; the scorer now compares by value (`903a8ec`, `0570508`, no change to judgement code) and the custodian re-scored that metric without a model. The other figures are from the original run. An earlier held-out set failed (field recall 87.2%, rule risk and template 97.5%) and led to the two fixes in this release; that set is consumed.

| Metric | Threshold | Result |
|---|---|---|
| Classification, macro F1 | ≥ 0.85 | 0.960 |
| Fields extracted by rules (re-scored after the scoring fix, see below) | 100% | 100% (126/126) |
| Field recall | ≥ 0.90 | 90.0% (442/491) |
| Field precision | ≥ 0.90 | 97.1% (440/453) |
| Fields that should stay empty | ≥ 0.95 | 100% (26/26) |
| Contact, commitment and deal linked correctly | ≥ 0.95 | 98.4% (123/125) |
| Risk never underestimated | 100% | 100% (126/126) |
| High-risk emails rated high | 100% | 100% (80/80) |
| Malicious bank-detail changes or look-alike senders rated high | 100% | 100% (18/18) |
| Replies never disclose more than allowed | 100% | 100% (126/126) |
| Prompt injection does not change the judgement (vs. a clean twin) | 100% | 100% (15/15) |
| Risk and template from the rules, given the annotated categories and fields | 100% | 100% (126/126) |
| Rule consistency against the independent implementation | 100% | 100% (126/126) |
| Real-model cancellations of an otherwise qualifying payment message (reported, no threshold) | — | 2 of 10 |

## v0.2.2 (2026-11-04): clearer demo boundaries and case review flow

- **Demo guidance:** fictional data and view-only access stay visible. About explains precomputed results and unavailable editing/approval workflows; build metadata is kept for version tracing. Internal evaluation-directory and sample-comparison notes no longer interrupt the public demo.
- **KYC and verification:** attachment transfer states remain distinct. A recorded transfer no longer suggests that demo removal is still pending; the attachment explains the demo exception and real-deployment limits. Read-only verification checklists no longer ask visitors to tick items.
- **Inbox navigation:** grouped filters, displayed counts, due-time ordering and warning-signal wording; native Case links and per-history-entry restoration of filters, focus and scroll. Live-service counts describe rows shown rather than claiming a complete total.
- **Case review:** a short current-result summary precedes email evidence and review panels. Business display names replace internal identifiers in primary content; classification evidence and diagnostic references remain accessible. Incomplete analysis, uncompleted checks, low confidence and risk awaiting confirmation stay explicit.
- **Validation:** 554 local unit/integration tests passed with 3 environment skips; 22 application and 9 static-demo browser tests passed, plus 3 display-layer mutation checks. Application, parser and Compose CI checks passed. The unchanged coverage script passed against their official CI reports (217 required cases); public release-candidate CI is required before publication. Approval/copy safeguards, no-send behavior and shared design tokens are unchanged.

### Evaluation carried forward from v0.2.0

The following held-out results were **measured on v0.2.0**, on a held-out set of 121 emails with Claude Opus 5.5. They are quoted unchanged under the G3 patch-release rule, not a new measurement. Classification, extraction, linking, risk, template selection, reply preparation, runtime configuration and evaluation inputs are unchanged. The enumerated non-UI differences are agent guidance, presentation-only requirements and test-plan documentation, and root package-version metadata. The validator’s consumed PRD field inventory is unchanged; presentation requirements and test-plan additions do not change the business judgement rules, runtime model inputs or metric thresholds. Development evaluation on recorded model replies is required again for this release.

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

The original prerelease failure and subsequent fresh-set PASS remain recorded in the v0.2.0 section. No consumed held-out set is rerun or reused as a new measurement.

### Scope and limits

This release changes product presentation only. Microsoft 365 and Gmail push notifications (Pub/Sub) were tested only against simulated services. Gmail polling was tested on one personal Gmail account. No new production-mail-volume, clean-machine, model or mailbox measurement is claimed.

## v0.2.1 (2026-11-04): Trunks product branding

- **Product name:** Trunks — Operations Inbox, part of Vegeta. The sign-in screen, review header, browser title, demo navigation and current user documentation use the confirmed product names.
- **Companion product:** the review UI displays Goten — Deal Calculations in withdrawal guidance, including existing records. Stored action details, API/CSV output and reply preparation hashes retain their existing values.
- **Compatibility:** repository URLs, package name, API, schema, configuration, secrets, cookies, Docker projects/volumes and storage paths are unchanged. Historical release notes and v0.2.0 assets are preserved.

### Evaluation carried forward from v0.2.0

The following held-out results were **measured on v0.2.0**, on a held-out set of 121 emails with Claude Opus 5.5. They are quoted unchanged under the G3 patch-release rule, not a new measurement. Classification, extraction, linking, risk, template selection, reply preparation, runtime configuration and evaluation inputs are unchanged. The enumerated non-UI differences are agent guidance and root package-version metadata only; neither affects the evaluated pipeline. Development evaluation on recorded model replies is required again for this release.

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

The original prerelease failure and subsequent fresh-set PASS remain recorded in the v0.2.0 section. No consumed held-out set is rerun or reused as a new measurement.

### Scope and limits

This release changes product presentation only. Microsoft 365 and Gmail push notifications (Pub/Sub) were tested only against simulated services. Gmail polling was tested on one personal Gmail account. No new production-mail-volume, clean-machine, model or mailbox measurement is claimed.

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
