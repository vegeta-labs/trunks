# Configuration reference

A configuration directory holds three YAML files:

| File | Contents |
|---|---|
| deployment.yaml | the deployment, mailboxes, model, limits, routing, retention, KYC target, sign-in |
| cases.yaml | the case categories (classes) |
| templates.yaml | the reply templates |

Compose mounts the directory read-only at `/config`. It comes from `DOI_CONFIG_DIR`, which defaults to
`./config/default`.

General rules:

- **Checked at every start.** An invalid file stops the start, and the message names the file, the line and the key.
  Unknown keys are errors.
- **Changes are audited.** The hash of the directory is recorded at start. When it changes, a `config.changed` audit
  record is written, and every Case that is not closed is processed again with the new configuration.
- **No secrets in these files.** Keys ending in `_env` hold the *name* of an environment variable. The app reads that
  variable, or the file named by `<NAME>_FILE`. Names are upper-case letters, digits and `_`.
- **Fixed rules cannot be configured.** These include the fraud rules and the built-in word lists. A key that tries to
  switch them off or replace a list fails with its own message. Word lists only accept additions, through `*_extra`
  keys.
- **Ids** (mailbox, class, queue and template ids) are lower-case letters, digits and `_`, starting with a letter.

Key paths below are dotted; `[]` marks an item of a list. "required" means there is no default.

## `deployment.yaml`

### `deployment`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `deployment.name` | string | required | Name of the deployment. Templates show it as `{deployment_name}`. |
| `deployment.timezone` | IANA time zone | required | Used for working days, deadlines and dates, for example `Europe/London`. |
| `deployment.currencies` | list of ISO 4217 codes | required | The currencies the deployment accepts, for example `[GBP, EUR, USD]`. At least one. |

### `mailboxes`

At least one mailbox is needed. Ids must be unique. See [Mailboxes](mailboxes.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mailboxes[].id` | id | required | Internal id. Keep it stable: cursors, duplicate detection and Cases refer to it. |
| `mailboxes[].name` | string | required | Name shown in the review UI. |
| `mailboxes[].kind` | `imap` \| `eml` \| `gmail` \| `graph` | required | The adapter. `imap` needs the `imap` block, `gmail` needs the `gmail` block here and the top-level `gmail` block, `graph` needs the `graph` block and the top-level `m365` block. |
| `mailboxes[].imap.host` | string | required for `imap` | IMAP server host name. |
| `mailboxes[].imap.port` | integer 1–65535 | required for `imap` | IMAP port, for example `993`. |
| `mailboxes[].imap.tls` | boolean | required for `imap` | Use TLS. |
| `mailboxes[].imap.user_env` | env name | required for `imap` | Variable that holds the user name. |
| `mailboxes[].imap.password_env` | env name | required for `imap` | Variable that holds the password. |
| `mailboxes[].imap.folder` | string | `INBOX` | The single folder to read, opened read-only. |
| `mailboxes[].gmail.address` | email address | required for `gmail` | The mailbox address. The OAuth consent must be given by this account. |
| `mailboxes[].gmail.labels` | list of label names | `[INBOX]` | Labels to receive, resolved at start-up. `SENT`, `DRAFT`, `SPAM` and `TRASH` are rejected. |
| `mailboxes[].graph.user` | email address | required for `graph` | The Microsoft 365 mailbox. |
| `mailboxes[].graph.folders` | list of folder names or paths | `[Inbox]` | Folders to receive, each with its own cursor. Paths such as `Inbox/Deals` are allowed. |
| `mailboxes[].strips_external_auth_results` | boolean | `false` | Declare `true` only when your gateway removes `Authentication-Results` headers that arrive from outside. Only then are those headers trusted. Not allowed for `eml`. |
| `mailboxes[].trusted_authserv_id` | string | none | The authserv-id your gateway writes, for example `mx.google.com` for Gmail. Required when `strips_external_auth_results` is `true`. |
| `mailboxes[].catch_up_minutes` | integer 1–1440 | `5` | Interval of the catch-up poll. |

### `gmail`

Optional. Required if any mailbox has `kind: gmail`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `gmail.client_id_env` | env name | required | Variable with the OAuth client id (Desktop app client). |
| `gmail.client_secret_env` | env name | required | Variable with the OAuth client secret. |
| `gmail.pubsub.topic` | `projects/<p>/topics/<t>` | none | Optional. The topic Gmail's watch publishes to. Without the `pubsub` block, the app only polls. |
| `gmail.pubsub.subscription` | `projects/<p>/subscriptions/<s>` | required with `pubsub` | The pull subscription the app reads. |
| `gmail.pubsub.service_account_env` | env name | required with `pubsub` | Variable with the JSON key of the service account that pulls from the subscription. |

### `m365`

Optional. Required if any mailbox has `kind: graph`. See [Mailboxes](mailboxes.md#microsoft-365).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `m365.tenant_id` | GUID | required | The Entra tenant id. |
| `m365.client_id` | GUID | required | The application (client) id. |
| `m365.client_secret_env` | env name | none | Variable with a client secret. Give exactly one of this and `certificate_key_env`. |
| `m365.certificate_key_env` | env name | none | Variable with the certificate's PEM private key (recommended). |
| `m365.certificate_thumbprint` | 40 hex characters | none | SHA-1 thumbprint of the certificate. Required with `certificate_key_env`. |
| `m365.permission_review.date` | `YYYY-MM-DD` | none | Date of your last permission review. If it is missing or older than 180 days, the start is refused. |
| `m365.permission_review.reviewer` | string | none | Who did the review. |
| `m365.negative_probe_mailbox` | email address | required | A real mailbox the app must **not** be able to read. It is probed at every start. |

### `esign_platforms`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `esign_platforms` | map: platform name → list of domains | required | E-signature services. A sender domain or link domain in the list marks the email as an e-signature invitation and records the platform name. Links are never opened. The default file lists four common services. |

### `attachments`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `attachments.max_attachment_bytes` | positive integer | required (default file: 20971520, 20 MB) | Largest single attachment that is parsed. |
| `attachments.max_total_bytes` | positive integer | required (default file: 52428800, 50 MB) | Largest total per email. Attachments past the total, in order, are marked over the limit. |
| `attachments.max_pdf_pages` | positive integer | required (default file: 50) | Most PDF pages parsed. |
| `attachments.parse_timeout_seconds` | integer 1–300 | required (default file: 30) | Time limit for parsing one attachment. |
| `attachments.max_nesting` | integer 0–3 | required (default file: 3) | Deepest nesting of attached emails that is parsed. |

An attachment over a limit is not parsed. Its Case is raised to high risk, and the attachment counts as possible-KYC
(see [Models and data protection](models-and-data-protection.md)).

### `signals` and `replies`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `signals.injection_markers_extra` | list of strings | `[]` | Phrases added to the built-in prompt-injection list. The `signals` section itself must be present. |
| `signals.pressure_words_extra` | list of strings | `[]` | Words added to the built-in pressure-language list (urgent, today, confidential, …). |
| `replies.internal_terms_extra` | list of strings | `[]` | Terms added to the built-in internal-terms list (fraud, suspicious, flagged, …). Templates and final reply texts must not contain them. |

All lists are matched as whole words, case-insensitive. The built-in lists cannot be shortened.

### `routing`

Deadlines are counted in working hours from the receive time, in `deployment.timezone`. Working days are Monday to
Friday, minus `routing.holidays`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `routing.working_hours.start` | `HH:MM` | `09:00` | Start of the working day. |
| `routing.working_hours.end` | `HH:MM` | `18:00` | End of the working day. Must be after the start. |
| `routing.targets_working_hours` | map: queue id → hours | `{ ops: 2 }` | Deadline per queue, in working hours. |
| `routing.default_target_working_hours` | positive number | `9` | Deadline for queues not in the map (one working day with the default hours). |
| `routing.remind_share` | number between 0 and 1 | `0.25` | A Case shows "due soon" when this share of its time is left. |
| `routing.holidays` | list of `YYYY-MM-DD` | England and Wales bank holidays 2025–2028 | Non-working days. **Replace or extend the list before 2029**, and for other jurisdictions. |
| `routing.follow_up.enabled` | boolean | `true` | Show a follow-up reminder on open payment Cases (`payment_query`, `payment_evidence`, `unreferenced_payment`). |
| `routing.follow_up.working_days` | positive integer | `10` | Working days after receipt before the follow-up reminder. It is a mail follow-up only, not a regulatory deadline. |

### `verification`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `verification.cooling_off_hours` | number ≥ 1 | `24` | Cooling-off period of a verification task, from the moment the checklist is done until an approver may approve. It can never be zero. |

### `events`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `events.webhook.url` | `https://` URL | none | Optional. Where JSON events are posted. HTTPS only; redirects are not followed. |
| `events.webhook.secret_env` | env name | required with `webhook` | Variable with the signing secret. Each request carries an HMAC-SHA256 signature in `X-DealOps-Signature`. |

Failed deliveries are retried after 1, 5 and 30 minutes and after 2 hours, then marked failed. Events of one Case are
delivered in order.

### `audit`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `audit.head_export_path` | path | required | File the audit chain head (latest sequence number and hash) is appended to daily. In Compose, use the `state` volume: `/var/lib/deal-ops-inbox/state/audit-head.jsonl`. Copy it to storage outside the deployment. |

### `retention`

See [Retention](retention.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `retention.messages_days` | positive integer or `forever` | `1826` (5 years) | Whole days, counted from the receive time, after which an email and everything derived from it is deleted. |
| `retention.directory_days` | positive integer or `forever` | `1826` | Days after a directory version stops being referenced by any Case before it is deleted. The current version is never deleted. |

### `kyc`

Where possible-KYC attachments are transferred. Without a target, transfers fail and are reminded daily.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kyc.inline_image.max_long_side` | positive integer, at most `1280` | `400` | Maximum longer dimension in pixels for the inline signature image exception. |
| `kyc.inline_image.max_short_side` | positive integer, at most `300` | `150` | Maximum shorter dimension in pixels for the exception. |
| `kyc.inline_image.max_bytes` | positive integer, at most `102400` | `51200` | Maximum transfer-decoded file size in bytes for the exception. |
| `kyc.target.kind` | `folder` \| `webhook` | none | The kind of target. |
| `kyc.target.path` | path | required for `folder` | Folder for the files. In Compose, the `kyc` volume is mounted at `/var/lib/deal-ops-inbox/kyc`. File names are generated (`<case id>-<n>.<ext>`), never the attachment's own name. |
| `kyc.target.url` | `https://` URL | required for `webhook` | Endpoint for the files. HTTPS only. |
| `kyc.target.secret_env` | env name | required for `webhook` | Variable with the HMAC signing secret (`X-DealOps-Signature: sha256=…`). |

Increasing these limits leaves larger eligible images in the archive under the normal retention period instead of
transferring them to the KYC target. Image contents never go to a model. The other MIME, HTML reference, scan and
structural conditions still apply. Use `scripts/measure-inline-images.ts` to measure a read-only Gmail inbox locally;
it prints counts, dimensions, byte sizes and fixed judgement codes, without saving mail or printing identifiers.

A webhook transfer succeeds only if the endpoint answers 2xx with a JSON body `{delivery_id, sha256}` and both values
match what was sent. Each request carries `Idempotency-Key: <delivery_id>`, so the receiver can drop duplicates.

### `model`

Optional in the file, but `serve` refuses to start without it. See
[Models and data protection](models-and-data-protection.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model.provider` | `anthropic` \| `ollama` \| `replay` | required | The model adapter. |
| `model.model_id` | string | required | The exact model id. |
| `model.location` | `local` \| `external` | required | Your declaration. `anthropic` must be `external`. |
| `model.region` | string | none | The provider's processing region, for example `eu` or `uk`. Outside UK / EEA without `transfer_basis` gives a warning. |
| `model.dpa` | boolean | required | A data processing agreement is in place. For an external provider, `false` refuses the start unless `allow_without_dpa` is set. |
| `model.no_training` | boolean | required | The provider does not train on your data. `false` gives a warning. |
| `model.transfer_basis` | string | none | Your legal basis for an international transfer, for example the name of the transfer mechanism. |
| `model.allow_without_dpa` | boolean | `false` | Start an external provider without an agreement anyway. Warns in the log and at the top of the review UI. |
| `model.api_key_env` | env name | `ANTHROPIC_API_KEY` | Variable with the hosted provider's API key. |
| `model.ollama_host` | URL | none | Ollama address. Required for `ollama`. No user name or password in it. |
| `model.replay_dir` | path | none | Directory of recorded replies. Required for `replay`. |

### `auth`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `auth.session_hours` | integer 1–336 | `12` | Session lifetime. |
| `auth.oidc.issuer` | URL | none | Optional OIDC sign-in: your identity provider's issuer URL. |
| `auth.oidc.client_id` | string | required with `oidc` | OIDC client id. |
| `auth.oidc.client_secret_env` | env name | required with `oidc` | Variable with the OIDC client secret. |
| `auth.oidc.redirect_uri` | URL | required with `oidc` | The callback address registered at the provider: `https://<your host>/auth/oidc/callback`. |
| `auth.oidc.role_claim` | string | required with `oidc` | The ID-token claim that carries the user's groups or roles (a string or a list). |
| `auth.oidc.role_map` | map: claim value → `reviewer` \| `approver` \| `admin` | required with `oidc` | Maps claim values to roles. The highest mapped role wins. A user with no mapped value cannot sign in. |

## `cases.yaml`

The case categories. Order matters: on a tie, the class listed first wins. The class `unclassified` is required. Ids
must be unique.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `classes[].id` | id | required | Class id, for example `payment_query`. |
| `classes[].risk_floor` | `low` \| `medium` \| `high` | required | The lowest risk a Case with this class can have. |
| `classes[].queue` | id | required | The queue Cases of this class go to, for example `ops`, `compliance`, `legal`. |
| `classes[].fields` | list of field names | none | Fields to extract for this class. Only known field names are accepted (amount, currency, payment_date, value_date, reference, uetr, deal, investor, consent_evidence, change_type, and so on). |

## `templates.yaml`

The reply templates. Each one is fixed text with `{placeholders}`. **Code chooses the template, never a model.** The
values come from code:

| Source | Placeholders |
|---|---|
| directory | `{contact_name}` `{investor_name}` `{deal_name}` `{reference}` `{cash_due}` `{currency}` |
| ledger | `{received_amount}` `{outstanding_amount}` |
| fields confirmed by a person | `{amount}` `{payment_date}` `{value_date}` `{uetr}` |
| system | `{deployment_name}` `{case_number}` |

If a placeholder has no value, the sentence that contains it is left out. Write each paragraph on one line.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `templates[].id` | id | required | Template id. Every template the code can choose is required: `safe_ack`, `notify_old_contact`, the payment templates and the per-class defaults. A missing one stops the start. Ids must be unique. |
| `templates[].subject` | string | required | Subject line, with placeholders. |
| `templates[].body` | string | required | Body text, with placeholders. Braces must balance, and only known placeholders are allowed. |
| `templates[].discloses_record` | boolean | none | Mark the template as disclosing record data. It is also set automatically when the template uses a directory or ledger placeholder, or asserts receipt. Such a template is used only when the sender is authenticated and the directory says the contact may see that commitment; otherwise code falls back to `safe_ack`. `safe_ack` cannot disclose. |
| `templates[].asserts_receipt` | boolean | none | Mark the template as saying a payment was received. It may then only use directory and ledger values. `safe_ack` and `notify_old_contact` cannot assert receipt. |

Template checks at load time:

- `safe_ack` may use system placeholders only.
- `notify_old_contact` may use system placeholders and `{contact_name}` only.
- No template may contain an internal term (built-in list plus `replies.internal_terms_extra`).
