# Models and data protection

A language model does two jobs only:

- it **classifies** an email into the categories of `cases.yaml`
- it **extracts fields**, such as amount, payment date and reference.

Each job is one request: the input is redacted text and a JSON Schema, and the output is JSON that the app checks.
There is no agent loop, and the model is given no tools. Everything else is done by fixed code: risk, linking,
deadlines, template choice and the reply text.

## Providers

| `provider` | `location` | What it is |
|---|---|---|
| `anthropic` | always `external` | The hosted model API. Needs `dpa`, `no_training`, `region` and the API key. |
| `ollama` | `local` (as you declare it) | A model on your own machine or network, reached at `ollama_host`. You run Ollama yourself; it is not part of the Compose file. |
| `replay` | `local` | Recorded model replies, read from `replay_dir`. Used for tests, the evaluation and the demo. A missing recording is an error; it never calls a real model. |

`model_id` names the exact model, for example `claude-opus-5-5`. If you change the model, change the configuration. The
configuration change is audited, and every open Case is processed again.

### Example: hosted provider with an agreement

```yaml
model:
  provider: anthropic
  model_id: claude-opus-5-5
  location: external
  region: eu
  dpa: true
  no_training: true
  api_key_env: ANTHROPIC_API_KEY
```

Put the API key in `secrets/anthropic_api_key`.

### Example: local model

```yaml
model:
  provider: ollama
  model_id: <the model name in your Ollama>
  location: local
  dpa: false
  no_training: true
  ollama_host: http://ollama.internal.example:11434
```

- `ollama_host` must not contain a user name or password.
- If the host does not look local (loopback, a private network address, a single-label service name or `.local`), the
  app starts but warns.

## Start-up checks (the model policy)

`serve` checks the model block before anything else starts.

| Situation | Result |
|---|---|
| No `model` block | **refuses to start** |
| `provider: anthropic` with `location: local` | **configuration error**: the hosted provider is always external |
| External provider with `dpa: false` and `allow_without_dpa` not set | **refuses to start** |
| External provider with `dpa: false` and `allow_without_dpa: true` | starts; **warning** in the start-up log and at the top of the review UI |
| External provider whose `region` is not UK / EEA, and no `transfer_basis` | starts; **warning** |
| `no_training: false` | starts; **warning** |
| `provider: anthropic` and the API key is empty | **refuses to start** |
| `ollama` declared local, host does not look local | starts; **warning** |

The UK / EEA test accepts region values such as `uk`, `gb`, `eu`, `eea`, `europe`, or an EEA country code (`de`,
`ie`, `fr` and so on).

These fields are your own **declarations**. The app cannot check a contract. Record the agreement itself, and the
transfer basis, in your [DPIA](dpia-template.md).

## What is sent to a model

Only **redacted** text. There is no setting that turns redaction off, and it applies to local models too.

The text sent is:

- the subject
- display names
- the body, including quoted earlier emails
- attachment file names
- the text of attachments that are **not** possible-KYC.

Before any model call, code replaces sensitive values with placeholders:

| Value | Placeholder |
|---|---|
| IBAN-shaped strings (whatever the check digits), UK account numbers near "account", "acc", "a/c" or "sort code" | `[ACCOUNT_n]` |
| UK sort codes | `[SORTCODE_n]` |
| UK passport numbers near "passport", UK driving licence numbers, National Insurance numbers | `[ID_n]` |
| Dates of birth near "born", "DOB" or "date of birth" | `[DOB_n]` |
| UK postcodes, with their line and up to three address lines above | `[ADDRESS_n]` |
| Phone numbers | `[PHONE_n]` |
| The local part of email addresses (the domain is kept) | `[EMAIL_n]@domain` |
| Names of people in your directory | `[NAME_n]` |

How the placeholders behave:

- Once a value is recognised anywhere in an email, every occurrence of it in that email gets the same placeholder.
- The table of placeholders and real values stays in your database, encrypted.
- Account, sort code, ID and date-of-birth placeholders are **never** turned back into values. They are shown masked,
  for example "account ending 5432". A model output field that contains one of them is discarded.
- Name, email, phone and address placeholders are restored only for display in the review UI.
- Amounts, payment references and UETRs are not redacted, because classification needs them. A reference is matched
  on the original text before redaction.

### Possible-KYC attachments go to no model

Before any model call, code (not a model) decides whether an attachment **may be a KYC document**. It is treated as
possible-KYC if any of these hold:

1. Its file name contains a KYC word, for example passport, driving licence, utility, bank statement, proof of
   address, certificate of incorporation, or the listed non-English equivalents.
2. Its text contains a passport machine-readable line, a KYC word, or two of "date of birth", "place of birth" and
   "nationality".
3. It is an image.
4. It is a PDF with no text layer on some or all pages.
5. It cannot be checked: parsing failed, timed out, was over a limit, was encrypted, was nested too deep, or the type
   is unknown.

The content of a possible-KYC attachment is **never sent to any model**, local or external. The model sees only its
redacted file name and its type. The Case is marked "possible KYC attachment", and the attachment is transferred to
your KYC target (see [Retention](retention.md)).

Inline images, such as signature logos, count as images. So most emails with a signature image trigger a KYC transfer.
This is deliberate: the rule errs on the side of caution.

The app does no OCR. The content of images and scans is never read.

### What is recorded about each model call

Each call is audited with:

- provider, model name and model version
- prompt version and schema version
- a hash of the input.

The full request and response are stored encrypted in the audit detail table. The audit row keeps only their hash.
The detail is deleted with the email at the end of its retention period.

A model call is tried at most twice per request. If both attempts fail, the email is classified `unclassified` and its
model fields are left empty. A person then reviews it as usual.

## What the model never does

- **It writes no outbound text.** Every reply is a fixed template from `templates.yaml`, with values filled in by
  code from your directory, your ledger and fields a person has confirmed.
- **It does not choose the template.** Code chooses the template from the category and the rules. A person may pick
  another template or edit the body of an ordinary template.
- **It cannot lower a risk level.** Risk comes from category floors and fixed rules. Only an approver can lower risk,
  and must give a reason.
- **It has no tools and no access** to mailboxes, the database, the network or any action.
- The prompt marks the email content as untrusted data, not instructions. This is only a secondary defence. The real
  defence is that the output is checked data with no power to act.
- Its output never makes a payment count as received, and never applies bank details. See the
  [Security model](security-model.md).
