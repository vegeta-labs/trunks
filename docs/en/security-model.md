# Security model

This page describes what the software does to limit harm, and where its limits are. It does not replace your own
security assessment.

## 1. Read-only by design

| Guarantee | How |
|---|---|
| No send capability | No code path sends email, writes drafts, moves, flags or deletes mail. The mailbox adapter interface has read methods only. There is no SMTP client among the dependencies. |
| Least permission per mailbox | Gmail: `gmail.readonly` only, and the granted scope is checked when saving and on every token refresh. Microsoft 365: application `Mail.Read` limited to the designated mailboxes, checked at every start (see [Mailboxes](mailboxes.md)). IMAP: the folder is opened read-only (`EXAMINE`), and only search and fetch are used. |
| Request allow-list | Every request to Google and Microsoft goes through one module. It allows only listed read requests (host + method + path) and fixed hosts, never follows redirects, and checks server-supplied paging links against the same list. Anything else throws before it is sent. |
| CI no-send check | The build fails if the source calls a write or send API of Gmail, Graph or IMAP, if the allow-list gains an entry or a write path, if code calls Google or Microsoft hosts directly, or if an SMTP package is added. |
| Replies are copied by a person | An approved reply is copied (recipient, subject, body) and sent by a person from their own mail client. The person then marks it as sent. |
| No business-system writes | The app imports your directory read-only. It only outputs events (an optional webhook) and CSV lists. |

**Remaining risk with IMAP:** an IMAP password usually also allows SMTP sending. Ask for SMTP to be disabled on the
account (see [Mailboxes](mailboxes.md#imap)).

## 2. The model has no power

- The model only classifies and extracts fields from redacted text.
- It has no tools, writes no outbound text and chooses no template.
- Its output is checked against a schema and can never lower risk.
- Possible-KYC attachment content goes to no model.

See [Models and data protection](models-and-data-protection.md).

## 3. Containers

| Service | Network | Secrets it gets | Notes |
|---|---|---|---|
| `db` (Postgres 16) | internal `backend` | the Postgres owner password | data in the `db` volume |
| `clamav` | `backend` (downloads virus database updates) | none | scans every attachment before it is parsed |
| `parser` | **none** (`network_mode: none`) | **none** | parses attachments that passed the scan; see below |
| `migrate` | `backend` | owner database URL, the three role passwords | runs once per start, creates tables and roles, then exits |
| `app` | `backend`, `edge` | app database URL, master keys, HMAC key, initial admin password, model key, plus the mailbox / webhook / OIDC secrets you add | API, review UI, pipeline, mail collection, KYC transfer; host port on `127.0.0.1` only |
| `maintenance` | `backend` | **maintenance** database URL, master keys, HMAC key | retention, file deletions, orphan clean-up, KYC replacement |
| `proxy` (optional) | `edge`, host ports 80 and 443 | none | Caddy, HTTPS |
| `rotate`, `gmail-auth` (tools) | as needed | rotation URL / app URL, keys | one-off commands |

All application containers:

- run as user 10001 with a read-only root file system (writable only on the data volumes and `/tmp`)
- drop all Linux capabilities
- set `no-new-privileges`.

### The parser sandbox

Attachments are untrusted files, so the main process only decodes MIME, within limits. Real parsing (PDF, DOCX text,
pacs.008 XML, nested emails) happens in the `parser` container:

- **No network** and **no application secrets.**
- Read-only root, non-root user, limits of 1 GB memory, 2 CPUs and 256 processes.
- **bubblewrap per task:** each parsing task gets its own mount, process and network namespaces. It sees only its own
  input file (read-only) and an empty output directory. It cannot see other tasks' files. Input and output are deleted
  when the task ends. There is a hard timeout.
- Each task also runs under bubblewrap's own seccomp filter, which refuses new namespaces, mount, keyrings, BPF,
  io_uring, ptrace and similar calls.
- **Dedicated seccomp profile** (`deploy/parser-seccomp.json`): Docker's default profile plus only the calls
  bubblewrap needs (`clone`, `unshare`, `mount`, `umount2`, `pivot_root`). CI checks that the file matches its
  generator script.
- **Dedicated AppArmor profile** (`deploy/apparmor/trunks-parser`): Docker's default rules plus only what bubblewrap
  needs (user namespaces, mounts below its staging root, `pivot_root`). If the profile is not loaded, the container
  does not start. The Compose file never uses `unconfined`.
- Macros and scripts are never run. XML with a DTD or entity declarations is not parsed.

### Maintenance has its own container and role

`maintenance` is the only running service with the `maintenance` database credentials. Those credentials allow
deletions. The `app` container has no maintenance, rotation or owner credentials, so a compromise of the app alone
cannot use the deletion rights.

Both containers hold the master keys. The split protects against deletion and rewriting, not against reading.

## 4. Database roles and the audit chain

| Role | Can |
|---|---|
| `trunks_app` | read all tables; insert into the tables it needs; update a listed set of status columns; delete only its own write intents, sessions and model-call reservations that were certainly not sent |
| `trunks_maintenance` | read all tables; delete in the fixed retention order; clear the link to a deleted earlier Case (a trigger allows clearing only); queue the one KYC continuation job |
| `trunks_rotation` | rewrap encrypted values and file headers during key rotation |
| owner (`postgres`) | used only by `migrate` |

- **No role can update or delete audit records.** Triggers refuse it too.
- Role passwords are set as SCRAM verifiers, so the password itself never appears in SQL.

**The audit chain.** Every audit record has:

- a gap-free sequence number
- a time and an actor
- a type
- `prev_hash`, the hash of the previous record
- `hash`, a SHA-256 over the record's canonical JSON.

Audit rows contain no personal data, only types, references, hashes and non-personal values. Personal values are kept
in an encrypted detail table, with only their hash in the audit row. That detail is deleted with the email at the end
of retention; the hash still proves the record existed.

- `audit verify` recomputes the whole chain and names the first broken sequence number.
- The chain head (latest sequence number and hash) is written daily to `audit.head_export_path`. Copy that file to
  storage outside the deployment, so that a deletion of the newest records can be detected.

```sh
docker compose exec app node --experimental-strip-types --no-warnings src/main.ts audit verify
docker compose exec app node --experimental-strip-types --no-warnings src/main.ts audit head
```

## 5. Encryption at rest

- **Files.** Raw emails and attachment files use envelope encryption: one AES-256-GCM data key per object, wrapped by
  a master key whose id is recorded.
- **Database text.** All text in the database is stored encrypted the same way. That includes subjects, names,
  addresses, file names, field values, quotes, drafts, directory contents, event contents, the redaction table, audit
  detail and OAuth tokens. Tables hold only ids, enums, hashes, times, integer amounts and booleans.
- **Lookups** that need to match text use an HMAC with the deployment key, not a plain hash.
- **Parser files.** Parser input and output live on tmpfs and are deleted after each task.
- **Key rotation** rewraps every data key and can resume after an interruption. See
  [Backup and upgrade](backup-and-upgrade.md#key-rotation).
- **Missing keys.** The app refuses to start while a master key that data still needs is missing.

## 6. Sign-in, sessions and CSRF

- Local accounts (argon2id password hashes) or OIDC with your own identity provider.
- Three roles:
  - **reviewer**: works Cases and edits replies
  - **approver**: also approves verification tasks, lowers risk and sets the hold flag
  - **admin**: also manages users, imports the directory and retries KYC transfers. Users and directory imports have
    no screen in this version; the admin uses the HTTP API (see [Users and directory](users-and-directory.md)).
- The first admin's password comes from a secret file, and it must be changed at first sign-in.
- Changing your password ends your other sessions. A credential reset ends all sessions of that user.
- Session cookie: `HttpOnly; Secure; SameSite=Strict`. `Secure` is always on, except in the local demo (which listens
  on `127.0.0.1` only) and with an explicit development setting.
- Every change request needs a CSRF token. The token is derived from the session with the deployment key, so any tab
  of the signed-in browser can fetch it again from `GET /api/csrf`. It ends with the session.
- Sign-in, CSRF and "change your password first" checks deny by default, based on the matched route. Only a few
  routes are public, such as sign-in and the OIDC callback.
- The review UI shows emails as **plain text only**. HTML is never rendered and remote content is never loaded. The
  Content-Security-Policy allows only the app's own origin.
- Request logs record the path only, never query strings, bodies or cookies.

## 7. Fraud rules (fixed in code, not configurable)

| Rule | What it means |
|---|---|
| **Emailed bank details are never applied** | No function writes bank details from an email into the directory or any record. A Case labelled `bank_details` can only get the `safe_ack` reply, even if its risk was lowered. Events carry the last four digits only. A verification task asks a person to call the phone number on file, not a number from the email. |
| **Emailed payment confirmations never count as received** | No email or attachment, including MT103 and pacs.008 messages, can make a payment "received". The UI and events call it "sender's confirmation, not proof of receipt". Receipt comes only from your imported bank lines and ledger. |
| **Risk flags never appear in outbound text** | Replies come only from fixed templates. Templates are checked at load time for internal terms (fraud, suspicious, flagged, verification task, …). The final text a person edits is checked again before it is saved. |

### Verification tasks and two-person control

Bank-detail and identity changes create a verification task:

1. A person calls the contact back on the phone number on file and completes a checklist.
2. A cooling-off period runs (default 24 hours, at least 1 hour).
3. A **different** person with the approver role approves.

Further checks:

- The two people can never have created each other's accounts, granted each other roles or reset each other's
  credentials.
- Both accounts, and the roles they hold now, must be older than one cooling-off period at the moment the checklist
  was done, and neither may have had a credential reset since one cooling-off period before that moment. A new
  account, a new role or a reset therefore waits one cooling-off period before it counts. On a new deployment the
  first approval is possible only after about two cooling-off periods (default about 48 hours).

The Case shows all conditions that block approval, separating the checklist completer's account history from your
own eligibility and the cooling-off period (C-FRD-5). If the completer's account or role was too new when the checklist
was done, waiting longer cannot fix that task. An approver or admin can choose **Restart verification** on an open or
checklist-done task and must give a reason. This invalidates the old task and regenerates an open checklist using the
contact on file; completion of the new checklist starts a new cooling-off period. Approved tasks cannot be restarted.
The Case's manual revision does not change. A Case being reprocessed, or an obsolete task binding, is refused.
The reason is encrypted audit detail and is never put in an event. If the only approver has a forbidden account-history
relationship with every possible completer, restarting cannot solve it; close the Case instead.

Completing a task only records that the process was followed. The app changes no record because of it.

## 8. Known limits

| Limit | What to do |
|---|---|
| The app cannot prove that Exchange gives it no send role. | The start-up check needs your permission review record (at most 180 days old). See [Mailboxes](mailboxes.md#permission-review-checklist). |
| IMAP credentials usually also allow SMTP. | Disable SMTP for the account, or record the risk. |
| Two-person control can be bypassed by one person who controls the identity provider or all admin accounts. | Make sure two different people manage their own accounts. |
| Model output varies between model versions. | Changing the model means changing the configuration. Measure again with the evaluation set. |
| Look-alike domain detection can give false positives. | It only raises risk; it never blocks. |
| Small inline signature images are not treated as possible-KYC (within `kyc.inline_image`). | They stay in the stored email under normal retention and are not transferred; so would an ID document scaled down to fit the limits, or encoded data hidden in an allowed image's text or metadata (at most 16,384 bytes in total). Wider limits widen this. Their content never reaches a model. Other images still count as possible-KYC. |
| No OCR. | Image and scan content is never read. |
| PostgreSQL's own server log can record the `DETAIL` of a constraint error, which may hold values from an email. The app's own error logs carry only fixed reason codes. | Keep the database log under the same access control and retention as the database. |
| Gmail's handling of forged `Authentication-Results` must be checked by you. | See the pre-go-live check in [Mailboxes](mailboxes.md#before-going-live-gmail-authentication-headers). |
| Microsoft 365 and Gmail Pub/Sub were tested only against simulated services. | Test with your own tenant before going live. |
| The AppArmor profile needs AppArmor 4 (for example Ubuntu 24.04). Docker Desktop on macOS ignores AppArmor. | On macOS the parser runs with seccomp and bubblewrap but without AppArmor. |
| Both `app` and `maintenance` hold the master keys. | Splitting the roles limits deletion, not reading. Protect the host. |
| A rare crash case: if two processes receive the same email at once, and one crashes after writing the file but before cleaning up, an original that the KYC replacement had already deleted can exist again until the hourly orphan clean-up. | Recorded limitation. The orphan clean-up removes it. |
| Backups keep data for as long as your backup policy keeps them. | Retention deletion does not reach backups. See [Retention](retention.md). |
