# Review summary

How each stage of Trunks — Operations Inbox (called Deal Ops Inbox before v0.2.1) was reviewed before it was accepted, written on 2026-11-11 for release v0.4.0. The raw review output and the item-by-item triage notes stay in the private development repository; this summary replaces them in the public one. It is brought up to date at minor releases, not at every patch release. Measured results are in [`CHANGELOG.md`](../../CHANGELOG.md); this file is about how the work was checked.

## How a review works

- **Docs first.** The requirements, technical design, rules and test plan (in [`docs/`](../), Chinese) were reviewed and approved before any implementation code was written. Each later milestone started with a written plan, reviewed the same way.
- **One pull request per requirement set**, with automated checks: type check, lint, a static check that the app has no way to send email, licence and dependency checks, unit, integration and browser tests, a check that every test-plan case due at that milestone ran and passed, the independent Python implementation of the rules, the development-set evaluation on recorded model replies, the sandboxed attachment parser, and the Docker Compose build with backup and restore. From v0.4.0 the full mutation run happens weekly.
- **Self-test gate.** Before the first Codex review of a pull request: a rule-by-rule comparison with the requirements, hostile inputs (malformed mail, huge attachments, zero-width characters, look-alike letters, prompt injection), mutation checks, and a fresh-context reviewer agent that uses the same prompt as Codex. Its findings are fixed first. From E3 on, a fresh reviewer also looked only for regressions after each round of fixes, because one fix had introduced a new blocker.
- **Codex cross-review**, looking for missed risk, data leaks, manipulation by email and unauthorised writes. Until 2026-11-09 it was repeated until it returned `READY`, or `READY AFTER FIXES` with the fixes applied (`REWORK` meant fix and review again). When Codex was unavailable, a fresh-context reviewer ran the same prompt, and in most cases Codex was run again later; only completed Codex runs are counted below.
- **From 2026-11-09, risk levels.** Each change is graded first. Low (copy, style, docs): self-test and CI. Medium (an ordinary feature): one fresh-context review. High (risk and anti-fraud rules, data exposure, permissions, payment judgement, release judgement, security and compliance docs): a fresh-context review and Codex in every round, plan and code reviewed separately, normally two plan and two code rounds at most (more needs the owner's OK). A round with no new blocker or major ends the review; after the planned rounds only the fixed parts are re-checked. Codex's verdicts became `READY`, `READY AFTER FIXES` and `NOT READY`.
- **Held-out (blind) tests.** Before a release that changes judgement, a new set of emails is written by independent agents that read only the requirements, kept away from development, and run once by an independent runner with a real model. The development side sees only the totals, and the set is used up after one report. A patch release may quote the last result only if the judgement code is unchanged, or every difference is listed and shown not to apply to that set.
- **Owner acceptance** before merge, often after a simulated acceptance in which a fresh agent works through the checklist as an operator in the browser; public release only after the release gate (G3) and the owner's explicit OK.

## Stages

| Stage | Codex rounds | Verdicts, in order | Fresh-context reviews |
|---|---|---|---|
| E0 requirements and design | 6 | REWORK ×5, READY AFTER FIXES | 2 |
| E1 ingest, redaction, storage, sandbox, CI | 5 | REWORK ×5 (findings 15, 7, 4, 2, 1 minor; the owner closed the review after the last minor fix) | 2 |
| E2 model classification, field extraction, evaluation set | 5 | REWORK ×4, READY AFTER FIXES | 3 |
| E3 linking, risk, anti-fraud, replies, events, CSV | 5 | REWORK ×4, READY | 8 (plan 2, requirements 1, gate 2, regression 3) |
| E4 Gmail, Microsoft 365, retention, KYC transfer, key rotation | 13 | REWORK ×6, READY; then 6 rounds on one clipboard fix after the first real-mailbox test: READY AFTER FIXES ×5, READY | 6 |
| E3 acceptance follow-ups | 2 | READY AFTER FIXES, READY | 1 |
| E5 packaging, demo, English docs | 7 | READY AFTER FIXES ×6, READY (rounds 5–7 after a deploy-from-the-docs test failed) | 5 |
| CI speed | 2 | READY AFTER FIXES, READY | — |
| G3 release v0.1.0 | 4 | READY AFTER FIXES, READY, READY AFTER FIXES, READY (rounds 3–4 on the release notes) | 1 |
| Empty directory import (v0.1.1) | 3 | READY AFTER FIXES ×2, READY | 1 |
| Demo and review screen (v0.1.1) | 2 | READY AFTER FIXES, READY | 3 |
| E6 signature images and other fixes before real use (v0.2.0) | 4 | REWORK ×3, READY | 11 (plan 5, rules 4, self-test 2) |
| v0.2.0 release and the injection fix | 2 | READY, READY | 3 |
| Renaming to Trunks (v0.2.1) | — | — | 2 (self-test: one not-ready finding, fixed; a final independent cross-review: READY) |
| Demo design (v0.2.2) | — | — | 6 independent reviews (design 2, code 1 and a follow-up, release metadata, CI install) |
| Accounts in payment messages (v0.3.0) | 8 | Plan: REWORK ×4, READY. Code: REWORK, READY (a second round was cut off by the usage limit and run by a fresh reviewer). Fix after a failed held-out test: READY AFTER FIXES | 4 |
| Inbox usability fixes (v0.4.0) | 2 | Plan: NOT READY. Code: READY | 2 |
| Closing rules and two-person checks (v0.4.0) | 4 | Plan: NOT READY ×2. Code: NOT READY ×2. The planned two rounds were reached; the last fixes were checked against the diff and tests | 4 |
| Operator guide (v0.4.0) | 2 | NOT READY (first guide), READY AFTER FIXES (v0.4.0 update) | 2 |
| Yes/no and multiple-choice fields (v0.4.0, medium risk) | — | — | 1 |
| v0.4.0 release: check that the v0.3.0 held-out result still applies | 1 | JUSTIFIED AFTER FIXES | 1 |
| **Total** | **77** | | |

Fresh-context reviews are counted by round; several reviewers working in parallel in one round count once. Not counted: two Codex runs stopped at the review service's usage limit without a verdict (E2, v0.3.0 code round 2). For v0.2.1 and v0.2.2 the records do not say whether the independent reviewer was Codex, so those reviews are not in the Codex total.

## What the reviews changed

- **Every finding was judged and recorded.** Each was accepted and fixed, or rejected with a written reason; from E3 on, fixes were checked by a separate regression review before the next round.
- **Held-out failures were reported.** The first v0.2.0 attempt failed injection invariance at 14 of 15; after the fix a completely new set was written and passed. For v0.3.0 an earlier set failed field recall and rule checks; it led to the two fixes in that release, and a new set was written. That new set first failed one metric because the scorer compared amounts as text; the scorer was fixed, with no change to the judgement code, and that metric was re-scored without the model. All of this is stated in `CHANGELOG.md`.
- **Real use changed the plan.** The first real-mailbox test in E4 led to six more rounds on one clipboard fix, and a failed deploy-from-the-docs test in E5 led to three more rounds and corrected documents.
- **Limits are stated, not hidden.** Where a review stopped at its planned rounds, or the last fix was checked against the diff and tests instead of another round, this table says so.

## Results

The held-out results for v0.1.0, v0.2.0 and v0.3.0, and which later releases quote them, are in [`CHANGELOG.md`](../../CHANGELOG.md). No figure in this file is new.
