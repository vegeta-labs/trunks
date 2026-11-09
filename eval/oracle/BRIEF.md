# Oracle brief (E1)

Brief for the independent agent that writes `eval/oracle/oracle.py` (test plan §3). The agent reads **only** `docs/01_PRD.md`, `docs/04_TEST_PLAN.md`, `eval/SCHEMA.md` and this file. It never reads `src/`, `parser/`, `scripts/` or any TypeScript.

## Goal
An independent Python reference for the E1 rules: C-EXT-1 to C-EXT-6 (incl. MT103 `:32A:` and pacs.008 XML), I-01, I-04, I-05, C-RED-1, C-SIG-1 (signals 1–8), C-SIG-3, C-LNK-3, C-AUD-1. Standard library only (Python 3.11). Where the PRD is ambiguous, pick the reading you think the text supports, say so in a comment starting `# READING:`, and list it in `eval/oracle/READINGS.md`. Do not ask anyone; do not look at the TypeScript to resolve it.

## Files
- `eval/oracle/oracle.py` — the functions below plus a CLI: reads JSON Lines on stdin, each `{"fn": <name>, "input": {...}}`, writes one JSON line per input `{"ok": true, "output": ...}` or `{"ok": false, "error": "..."}`.
- `eval/oracle/selfcheck.py` — runs every concrete example in the test plan for these rules (TC-EXT-*, TC-SIG-01–11 and 13, TC-RED-01–03/06–08/10 (redaction part), TC-LNK-07, TC-AUD-01 hash part) plus the PRD's inline examples; exits non-zero on any failure. Name each check after its TC id.
- `eval/oracle/READINGS.md` — every interpretation you had to make.

## Functions (input → output)
All text inputs are the original text; apply I-04 yourself where the PRD says so. Positions are code-point offsets into the **I-04-normalised** text.

1. `normalize` `{text}` → `{text}` (I-04).
2. `wordlist_match` `{text, phrases: [str]}` → `{matched: [phrase]}` (I-05, after I-04).
3. `parse_amount_number` `{s}` → `{minor: int}` or `{minor: null}` (I-01 number part only, no currency).
4. `amounts` `{text}` → `{amounts: [{minor, currency, start, end}]}` (C-EXT-3 amount tokens in free text; not `:32A:`).
5. `mt103` `{text}` → `{items: [{value_date, minor, currency}]}` (`:32A:` fields).
6. `pacs008` `{xml}` → `{parsed: true, items: [{minor, currency, value_date|null, uetr|null}]}` or `{parsed: false, reason}` (C-ING-2 XML rules + C-EXT-3; reject DTD/external entities; non-pacs.008 → not parsed; size limit 1 MB).
7. `uetr` `{text}` → `{uetrs: [lowercase], invalid: [lowercase], multiple: bool}` (C-EXT-1; de-duplicated, order of first appearance).
8. `references` `{text, known: [str]}` → `{matched: [str as given in known]}` (C-EXT-2).
9. `accounts` `{text}` → `{accounts: [{kind: "iban"|"uk", last4, country|null}]}` (C-EXT-4).
10. `dates` `{text}` → `{dates: [{iso|null, status: "ok"|"ambiguous"|"invalid", start, end}]}` (C-EXT-5, free text; YYMMDD only inside `:32A:` which is `mt103`'s job).
11. `esign` `{from_domain, link_domains: [str], platforms: {name: [domain]}}` → `{esign_invite: bool, platform: str|null}` (C-EXT-6).
12. `redact` `{text, contact_names: [str]}` → `{spans: [{start, end, kind}]}` where `kind` ∈ `ACCOUNT, SORTCODE, ID, DOB, ADDRESS, PHONE, EMAIL, NAME`; for EMAIL the span covers the local part only. Spans are over the normalised text, non-overlapping, sorted. Also return `{text}`: the normalised text with each span replaced by `[KIND_n]`, n numbered per kind from 1 in order of first appearance of each distinct value, same value → same placeholder.
13. `name_similarity` `{a, b}` → `{num: int, den: int}` (C-LNK-3, unreduced: matched pairs over the larger word count; `0/0` → `{num: 0, den: 0}` meaning 0).
14. `signals` →
   input `{mailbox_strips_auth_results: bool, adapter: "imap"|"gmail"|"graph"|"eml", trusted_authserv_id: str, headers: [[name, value]] (top to bottom), from: {name, address}, reply_to: str|null, contacts: [{contact_id, name, emails: [str]}], prior_from_addresses: [str], html: str|null, texts: [str] (body text, attachment texts, subject and header values to scan)}`
   output `{auth: "fail"|"pass"|"unknown", auth_fail: bool, untrusted_auth_header: bool, display_name_mismatch: bool, lookalike_domain: bool, reply_to_mismatch: bool, first_time_sender: bool, hidden_text: bool, injection_markers: bool, dmarc_pass: bool}`.
   For `lookalike_domain`, the "UTS #39 skeleton" step: implement with a small confusables table covering at least Cyrillic and Greek letters that look like Latin a–z; note this in READINGS.
15. `authenticated_sender` `{signals_input (as 14)}` → `{authenticated: bool, contact_id|null}` (C-SIG-3 with C-LNK-1).
16. `audit_hash` `{record: {seq, time, actor, type, case_id, payload, prev_hash}}` → `{hash}` (C-AUD-1, RFC 8785 JCS; implement JCS yourself for the JSON types that appear: objects, arrays, strings, integers, booleans, null).
17. `verify_chain` `{records: [...]}` → `{ok: bool, bad_seq: int|null}`.

## Done when
`python3 eval/oracle/selfcheck.py` passes; report back a short summary and the list of readings.

---

# Oracle brief, part 2 (E3)

Same rules as above: read **only** `docs/01_PRD.md` (v0.7.12), `docs/04_TEST_PLAN.md` (v0.7.11), `eval/SCHEMA.md`, this file and the existing files in `eval/oracle/`; never `src/`, `parser/`, `scripts/`, `eval/*.ts` or any TypeScript; never the holdout folder. Keep the E1 functions working. Add `# READING:` comments and `READINGS.md` entries for every interpretation.

## Goal
Independent Python reference for the E3 rules named in test plan §3: C-RSK-1 to C-RSK-3 (incl. the v0.7.12 manual adjustment ①–⑦), C-RTE-1 and C-RTE-2, C-DRF-2 to C-DRF-6 (with C-LNK-5 and C-DRF-1's `discloses_record` / `asserts_receipt` lists from C-DRF-5), C-OUT-3. Plus the PRD §6 «规则一致（实际输入）» check over the export described in test plan §3.

## Common inputs
- `classes`: the class table in order, `[{id, risk_floor}]` (the order is PRD §3.1's order; a deployment may change floors).
- `calendar`: `{timezone, start: "HH:MM", end: "HH:MM", holidays: ["YYYY-MM-DD"]}`. Use `zoneinfo` for the time zone.
- Risk reason IDs (interface vocabulary for C-RSK-3 R0; one per clause): class IDs as they are, and `C-RSK-2:display_name_mismatch`, `C-RSK-2:lookalike_domain`, `C-RSK-2:hidden_text`, `C-RSK-2:injection_markers`, `C-RSK-2:message_id_collision`, `C-RSK-2:first_time_sender_account`, `C-RSK-2:uetr_candidate_invalid`, `C-RSK-2:amount_mismatch`, `C-RSK-2:attachment_blocked_or_over_limit`, `C-RSK-2a:auth_fail`, `C-RSK-2a:untrusted_auth_header`, `C-RSK-2a:reply_to_mismatch`, `C-RSK-2a:pressure`, `C-RSK-2a:closing`.

## Functions (add to the CLI)
18. `working_days_after` `{from, to, calendar}` → `{days}` (C-DRF-4 count; C-RSK-2a v0.7.12).
19. `due_at` `{received_at (ISO UTC), working_hours (number), calendar}` → `{due_at (ISO UTC)}` (C-RTE-1; C-RTE-2 = 10 working days × the day length).
20. `due_state` `{received_at, due_at, now, remind_share, calendar}` → `{state: "ok"|"due_soon"|"overdue"}` (R-RTE-02).
21. `risk` `{classes, adopted: [id], low: [id], signals: {9 signals as in SCHEMA, null = unknown}, account_present: bool (an IBAN-shaped string or UK account), uetr_candidates_invalid: [str], amounts_body: [{minor, currency}], amounts_attachment: [{minor, currency}], attachment_blocked_or_over_limit: bool, pressure_text: str|null (subject + body incl. quoted mail) or pressure_words: bool, planned_close_date: str|null, received_at, calendar, adjustment: null | {level, computed_at_set, reasons: [reason id]}}` → `{computed: level, reasons: [reason id] (the reasons present now, for R0), final: level, adjustment_void: bool}`.
22. `may_disclose` `{authenticated_sender: bool, commitment_key: str|null, contact_investor_ids: [key], contact_authorised_for: [key]}` → `{allowed: bool}` (C-LNK-5).
23. `ledger_state` `{commitment_key, investor_id, deal_currency, cash_due_minor, ledger: null | [{status, investor_id, currency, amount_minor}]}` → `{state: "received"|"not_received"|"unknown"}` (C-DRF-6; `ledger: null` = no ledger for that deal in the snapshot).
24. `template` `{classes, adopted: [id], risk, linked_commitment: bool, ledger_state, evidence_value_dates: [date], value_date: str|null|{"multiple": [...]}|{"void": str}, payment_date: same, received_at, calendar, may_disclose: bool}` → `{template: id|null, primary: id|null}` (C-DRF-3 ①–⑤, C-DRF-4, C-DRF-5).
25. `reply_check` `{text, extra_internal_terms: [str]}` → `{ok: bool, hits: [phrase]}` (C-DRF-2 ②, C-FRD-3 list).
26. `fill` `{template_text, values: {placeholder: str|null}}` → `{text, removed_sentences: int}` (C-DRF-2 ③).
27. `recipient` `{kind: "case_reply"|"notify_old_contact", from, reply_to: str|null, reply_to_mismatch: bool, directory_email: str|null, proposed: str}` → `{allowed: bool}` (C-DRF-2 ④).
28. `actions` `{adopted: [id], fields: {consent_evidence, change_type, confirms, ...as SCHEMA, with multiple / void}, confirms_confirmed_by_person: bool, linked_commitment: bool, template: id|null, authenticated_sender: bool, sender_is_lead_of_deal: bool, investor_name, reference, deal}` → `{actions: [{action, details}]}` (C-OUT-3, in table order; `none` with details `null`).

## Consistency check
`eval/oracle/check_actual.py <dir>`: reads every `<id>.actual.json` in `<dir>` (format: test plan §3, «E3 规则一致» paragraph), recomputes risk (no manual adjustment in evaluation) and template with the functions above using the class table from the file `<dir>/classes.json` (`[{id, risk_floor}]` in order) and calendar `<dir>/calendar.json`, prints one line per mismatch and a summary, exits non-zero on any mismatch.

## Self-check
Extend `selfcheck.py` with every concrete example in the test plan for these rules: TC-RSK-01–09 (rule parts), TC-RTE-01–05 and 08, TC-DRF-02, 03, 04, 05, 06, 07, 10, 11a/b (rule part), 15, TC-LNK-05, 09 (C-LNK-5 part), TC-OUT-07, 08 (rule part), plus the PRD's inline examples (C-RSK-2a v0.7.12 day counts). Use the England and Wales bank holidays for 2026 where a case needs them (state the list in READINGS).

## Done when
`python3 eval/oracle/selfcheck.py` passes; report back a short summary and the list of new readings.

# Oracle brief, part 3 (E4)

Same rules as above: read **only** `docs/01_PRD.md` (v0.7.18), `docs/04_TEST_PLAN.md` (v0.7.13), `eval/SCHEMA.md`, this file and the existing files in `eval/oracle/`; never `src/`, `parser/`, `scripts/`, `eval/*.ts` or any TypeScript; never the holdout folder. Keep the E1 and E3 functions working. Add `# READING:` comments and `READINGS.md` entries for every interpretation.

## Goal
Independent Python reference for C-RED-0 (which attachments are «possibly KYC»), including I-04 normalisation and I-05 whole-word matching as C-RED-0 uses them (CJK characters separate English words; the six Chinese words match as substrings, PRD v0.7.11), the nested-attachment rule and C-ING-2's «unparsed XML counts under ⑤». From E4 this judgement decides which attachments are transferred and then deleted (PRD R-PRV-03, C-PRV-2), so it needs an independent check (test plan §3, v0.7.13).

## Function (add to the CLI)
29. `kyc` — input exactly as test plan §3 defines one item of the `attachments` export (without `maybe_kyc`; `parse_status` values and the meaning of `text` are defined there) → `{maybe_kyc: bool, clauses: ["1".."5"]}` (C-RED-0 ①–⑤; `clauses` lists every clause that holds, in order). Note PRD C-RED-0 ② reads «全部文字内容（含嵌套附件）里出现…»: decide from the PRD text how an attachment's own text and its `children`'s text combine (for example two of date of birth / place of birth / nationality split across levels), and record that decision in `READINGS.md`.

## Consistency check
Extend `eval/oracle/check_actual.py`: when an `<id>.actual.json` has an `attachments` list (each item the input shape above plus the system's `maybe_kyc`; format in test plan §3), recompute `kyc` for every top-level attachment and report each mismatch with the sample id and ordinal.

## Self-check
Extend `selfcheck.py` with every concrete example in TC-RED-04 and the PRD's inline examples for C-RED-0 (`Passport扫描件.pdf`, `Kontoauszug_2026.pdf`, the CR / NEL / U+2028 / U+2029 line breaks before the machine-readable zone, 5,000 ordinary characters before it, nesting 4 levels deep), plus negative cases you derive from the text (an ordinary invoice PDF; a word that only contains a keyword inside a longer English word).

## Done when
`python3 eval/oracle/selfcheck.py` passes and `check_actual.py` handles files with and without `attachments`; report back a short summary and the list of new readings.

# Oracle brief, part 4 (E6)

Same rules as above: read **only** `docs/01_PRD.md` (v0.7.25), `docs/04_TEST_PLAN.md` (v0.7.21), `eval/SCHEMA.md`, this file, the existing files in `eval/oracle/` and the sample files `eval/dev/<id>.eml` / `.json`; never `src/`, `parser/`, `scripts/`, `eval/*.ts` or any TypeScript; never the holdout folder. Python standard library only; do **not** use `html.parser` (PRD appendix B.4). Keep the earlier functions working. Add `# READING:` comments and `READINGS.md` entries for every interpretation.

## Goal
1. C-RED-0 ③ now has an exception for small inline signature images (PRD v0.7.25, rule text in C-RED-0 ③ ⓐ–ⓕ and the full byte-level rules in **appendix B**). Implement it independently: read the outer parts of the raw `.eml` yourself (B.1 numbering), the Content-ID / disposition rules (B.2), strict base64 (B.3), the token-level HTML scan (B.4), the PNG / JPEG / GIF structure checks with the combined 16,384-byte caps (B.5) and the default thresholds (B.6). Anything uncovered or unreadable fails closed.
2. C-DRF-6 has a new half sentence (v0.7.24): an empty ledger left by an explicit clear counts as no ledger («未知»). Update `ledger_state` if needed (the current evaluation set has no such case; add a self-check example).

## Functions (add to the CLI)
30. `inline_signature` `{eml_path, ordinal, scan: "passed"|"blocked"|"over_limit", thresholds?: {max_long_side, max_short_side, max_bytes}}` → `{exempt: bool, reason: str}` (`reason`: the first failed condition, or `"inline_signature"`).
31. Change `kyc` so that an image attachment for which `inline_signature` is exempt is judged only by ① (test plan §3 v0.7.21: the export's `parse_status` gives ⓓ; the oracle needs the `.eml` path for the rest). Keep the old input shape working (no `.eml` → no exception).

## Consistency check
Extend `check_actual.py`: for each top-level attachment in `<id>.actual.json`, call `kyc` with the exception using `eval/dev/<id>.eml` and report each mismatch with sample id and ordinal.

## Self-check
Extend `selfcheck.py` with every concrete example in TC-RED-11 (build the `.eml` and image bytes in the test with the standard library: `zlib` / `struct` for PNG and its CRCs, hand-assembled JPEG and GIF byte sequences — structure only, they need not decode as pictures), the boundaries listed there, and the examples in appendix B.

## Done when
`python3 eval/oracle/selfcheck.py` passes and `check_actual.py` handles the new check; report back a short summary and the list of new readings.

# Oracle brief, part 5 (F1)

Same rules as above: read **only** `docs/01_PRD.md` (v0.7.28), `docs/04_TEST_PLAN.md` (v0.7.26), `eval/SCHEMA.md`, this file, the existing files in `eval/oracle/` and the sample files `eval/dev/<id>.eml` and `.json`. Never `src/`, `parser/`, `scripts/`, `eval/*.ts`, `docs/review/`, the holdout or `.env*`.

## Goal
Independent Python reference for PRD C-CLS-4, C-CLS-4a and appendix C, C-RSK-2 `evidence_beneficiary_mismatch`, C-RED-1's structural accounts, C-DRF-4's new step, C-OUT-3's new action, C-DIR-1a.

## Functions (add to the CLI)
32. `payment_message` `{kind, parse_status, top_level: bool, text, xml: str|null, currencies}` → `{structured: bool, payers: [str], beneficiaries: [str], problem: "M2"|"M3"|"M4"|null}` (M1–M4, appendix C.0–C.2, C.4). `xml` is the raw file for a pacs.008; you parse it yourself with the standard library, without reading a DTD.
33. `redirect_wording` `{text}` → `{hit: bool}` (C.5). 34. `explicit_redirect` `{text}` → `{hit: bool}` (C.6).
35. `evidence_exemption` `{subject, body, body_html, attachments: [{kind, parse_status, filename, text, xml, maybe_kyc}], currencies, signals, dmarc_pass, sender_contact: {deals, investor_ids, authorised_for}|null, reference_deals: [str], blocked_or_over_limit, model_labels: [str]|null, prior_bank_rule, receiving_accounts: {deal: [str]}}` → `{applied: bool, deal: str|null, reason: "M2"|"M3"|"M4"|"M5"|"E2"|"E3"|"E4"|"E5"|"E6"|null}`. Reason = the failed condition; the order of checks is not part of the rule, so compare `applied` strictly and report `reason` only for reading.
36. `rule_labels` `{subject, body, body_html, attachment_texts, esign_invite, payment_evidence_parsed, evidence_anywhere, exempt_attachment: int|null, prior_bank_rule}` → `{labels: [str]}` (C-CLS-4 plus C-CLS-4a).
37. `beneficiary_mismatch` `{structured_beneficiaries: [str], linked_deal: str|null, receiving_accounts, exempted_deal: str|null}` → `{hit: bool}` (C-RSK-2).
38. `evidence_supports_tracing` `{attachments, currencies, deal_currency, cash_due_minor, received_at_date}` → `{ok: bool}` (C-DRF-4). Extend `template` with this input, and `actions` with `check_payment_evidence`.
39. Extend `redact` with C-RED-1's structural accounts (a `pacs_accounts` input gives the positions for pacs.008, or derive them from the raw XML).

## Consistency check
Extend `check_actual.py`: when an `<id>.actual.json` has `f1_input` (format in test plan §3 v0.7.26), recompute `evidence_exemption`, `rule_labels`, the mismatch and the template using `eval/dev/<id>.eml` for raw XML, and report each difference from `rule_labels`, `risk` and `template` with the sample id. `prior_bank_rule` is false in the first generation these exports describe.

## Self-check
Extend `selfcheck.py` with every concrete example in TC-CLS-10 to TC-CLS-18, TC-RED-13, TC-DIR-10, TC-DRF-21.

## Done when
`python3 eval/oracle/selfcheck.py` passes and `check_actual.py` handles files with and without `f1_input`; list your new readings in `eval/oracle/READINGS.md`. Report back a short summary, the readings, and every place the PRD was ambiguous or contradicted a test case. Do not resolve those silently.
