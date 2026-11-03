# Evaluation set — development families

Development-set families only (the holdout plan is kept in the private holdout repository). Sample IDs share one numbering space with the holdout set, so the ranges below have gaps.

| Family | Description | Samples | ID range | Writer batch |
|---|---|---|---|---|
| F001 | Northwind investors ask 'I paid, has it arrived?' across ledger states | 9 | E0001–E0009 | W1 |
| F003 | MT103 payment confirmations (valid) sent by investors | 5 | E0015–E0019 | W1 |
| F005 | pacs.008 XML attachments: root, AppHdr envelope, two transactions, GrpHdr-only date | 4 | E0024–E0027 | W1 |
| F006 | Malformed payment confirmations from genuine investors | 4 | E0028–E0031 | W1 |
| F008 | Payments without a reference or paid by someone else | 5 | E0034–E0038 | W1 |
| F010 | Payment evidence as a phone screenshot (PNG) | 2 | E0043–E0044 | W1 |
| F011 | Individual KYC documents sent by investors | 5 | E0045–E0049 | W1 |
| F013 | Withdrawal requests via adviser or lead with consent evidence variants | 5 | E0053–E0057 | W1 |
| F015 | Withdrawal written by the investor personally (see QUESTIONS Q1) | 2 | E0061–E0062 | W2 |
| F016 | Commitment amount changes and top-ups | 5 | E0063–E0067 | W2 |
| F018 | Fee payer and terms changes from leads/companies | 6 | E0071–E0076 | W2 |
| F020 | Lead confirms final closing numbers (yes / no / question) | 5 | E0082–E0086 | W2 |
| F022 | E-sign invitations and legal documents | 5 | E0090–E0094 | W2 |
| F024 | Genuine bank details provided (benign, still high) | 4 | E0098–E0101 | W2 |
| F026 | Identity / contact detail changes | 5 | E0104–E0108 | W2 |
| F028 | SEIS/EIS certificate requests | 5 | E0112–E0116 | W2 |
| F030 | Exit and distribution questions | 4 | E0120–E0123 | W3 |
| F032 | Bank asks / investor asks for investment confirmation letter | 4 | E0127–E0130 | W3 |
| F034 | Account access problems | 4 | E0134–E0137 | W3 |
| F036 | Complaints | 4 | E0141–E0144 | W3 |
| F038 | Other known low-frequency cases | 6 | E0148–E0153 | W3 |
| F040 | Not classifiable / out of scope | 6 | E0160–E0165 | W3 |
| F042 | Multi-class emails (two requests in one email) | 8 | E0171–E0178 | W3 |
| F044 | Long reply chains (4+ quoted messages) | 6 | E0185–E0190 | W4 |
| F046 | Non-English emails (FR, DE, ES, ZH — two each) | 8 | E0195–E0202 | W4 |
| F048 | Look-alike benign emails (should not raise risk) | 9 | E0209–E0217 | W4 |
| F050 | Bank-change fraud: look-alike company domain announces new receiving account | 5 | E0225–E0229 | W4 |
| F051 | Bank-change fraud: display-name impersonation of investors | 4 | E0230–E0233 | W4 |
| F054 | Look-alike / display-name impersonation (non-bank goals) | 6 | E0241–E0246 | W5 |
| F056 | Prompt injection in plain text, subject, full-width and split forms — with twins | 12 | E0252–E0263 | W5 |
| F057 | Prompt injection hidden in HTML (CSS-hidden text, comments) — with twins | 8 | E0264–E0271 | W5 |
| F060 | Forged or altered payment evidence | 4 | E0286–E0289 | W5 |
| F062 | Pressure tactics on money-related requests | 4 | E0293–E0296 | W5 |

Total: 33 families, 178 samples.
