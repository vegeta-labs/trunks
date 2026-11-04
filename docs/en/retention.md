# Retention

## Default periods

Change them in `deployment.yaml` under `retention`. Each value is a whole number of days or `forever`.

| Category | Default | Counted from | Key |
|---|---|---|---|
| **All data of one email**: the message row, the raw email and attachment files (with all stored versions), parse results, the Case and its labels, fields, links, signals, replies, verification tasks, the redaction table, the audit detail, and the Case's event outbox rows | 5 years (1826 days) | the email's receive time | `retention.messages_days` |
| **Directory versions** (deals, commitments, bank lines, ledger, contacts) | 5 years (1826 days) | the day the daily job finds that no Case snapshot refers to the version any more | `retention.directory_days` |
| The **current** directory version of each kind (per deal for commitments, bank lines and ledger; global for deals and contacts) | never deleted | — | — |
| **Audit rows** | kept forever | — | (fixed; they hold no personal data) |
| **Possible-KYC attachments** | deleted from the app as soon as **every** possible-KYC attachment of the email has been transferred successfully; kept, with a daily reminder, while a transfer fails | — | (fixed) |
| **Demo data** | reset at every `docker compose up` of the demo (not when Docker restarts a container on its own) | — | (fixed) |
| **Mailbox credentials** (Gmail refresh tokens) | kept until you remove them, **also after the mailbox is removed from the configuration** (nothing deletes them on its own); a token replaced by a new `gmail-auth` is deleted by the daily clean-up | — | see below |
| **Backups** | your own backup policy | — | outside the app |

In one email thread, each email expires on its own receive time. When an earlier email is deleted, the later Case's
link to it is cleared, and the clearing is audited.

## How deletion works

- **The daily job.** The `maintenance` container runs retention when it starts and then every 24 hours. It is the only
  running service with the database role that may delete.
- **One email at a time.** Each email is deleted in one transaction, in a fixed order. First a file-deletion job is
  recorded, then the database rows are deleted, including the encrypted text they refer to. After the commit, a
  background job deletes the files and every stored version of them. If the files cannot be deleted, the job stays
  and is retried every ten minutes, and the review UI shows a reminder. The deleted rows are not brought back.
- **Audited.** Each deletion writes an audit record (`retention.deleted`) with references and hashes only, never
  content. One email that cannot be deleted is audited as `retention.failed` and tried again the next day. It does
  not stop the others.
- **Other daily clean-ups.** The daily job also:
  - deletes directory versions whose period has ended (`retention.directory_days`), and snapshots no Case refers to
  - deletes encrypted text that nothing refers to any more (for example a replaced token)
  - writes KYC transfer reminders.
- **Hourly orphan clean-up.** Files written by an interrupted receive and never recorded are removed.

### The hold flag

An approver or admin can put a Case **on hold**, for example during a complaint or a dispute, and must give a reason.
A reviewer cannot. Setting and clearing the hold are audited, with the reason stored as encrypted detail.

- A Case on hold is not deleted until the hold is cleared.
- **Earlier Cases in the same thread are kept too:** every Case before it, following the links back.
- The hold does **not** stop the KYC transfer and replacement below.
- The hold is shown in the Case list and on the Case page.

## KYC transfer and replacement

Code decides whether an attachment may be a KYC document (see
[Models and data protection](models-and-data-protection.md#possible-kyc-attachments-go-to-no-model)). Each such
attachment is transferred to your target in `kyc.target`:

- **Folder target.** The file is written to a temporary file, flushed to disk, renamed, then read back. The transfer
  succeeds only if the SHA-256 matches. File names are generated as `<case id>-<n>.<ext>`.
- **Webhook target.** The file goes to an HTTPS endpoint, signed, with an idempotency key. The transfer succeeds only
  if the endpoint answers 2xx with the same transfer id and SHA-256.

How transfers run:

- A transfer starts as soon as the KYC decision is saved at the redaction step, before classification. A later model failure does not delay it. Each attachment is transferred once.
- A failed transfer is tried again a few times, then once a day until it succeeds. An admin can retry it from the Case
  page. Every retry is audited.
- While a transfer has failed, the review UI shows a reminder and a reminder is audited daily.
- **An attachment blocked by the virus scanner is not transferred,** so a malicious file never reaches your
  KYC target. The original is kept and reminded daily. After handling it by hand, an admin marks it "handled
  manually" on the Case page, with a reason. From then on it counts as dealt with.

**Replacement.** When **all** possible-KYC attachments of an email are dealt with, the `maintenance` container
replaces the stored email in five steps:

1. Write a copy of the raw email in which each such attachment is replaced by a small placeholder part.
2. Read the copy back and check its SHA-256.
3. Record the copy and both hashes.
4. Delete:
   - the original raw email with all stored versions
   - the attachment files
   - the text parsed from them, quotes and intermediate results
   - redaction entries and audit detail that came from them
   - unsent replies, automatic links, undelivered events and a person's field edits from before the replacement.

   Sent replies, delivered events and audit rows are kept.
5. Audit the replacement.

Each step is recorded. After an interruption, the job continues from the recorded step, and nothing is deleted before
step 3. The Case is then processed again without the deleted content, and a person confirms its fields again. Only a
hash and the transfer record of each KYC attachment remain.

If any transfer of the email has failed, nothing is replaced and the originals are kept.

If a later run newly identifies another attachment as possible KYC after replacement has finished, that attachment
is transferred too. Once all transfers succeed, another recorded replacement round removes it from the current
archive copy. A judgement change during a replacement is recorded as pending. The app checks pending decisions at startup and every minute, and reprocesses them after the round finishes and the lock is available; a restart does not lose the retry. Previously withheld or
removed attachments are never reclassified as safe by reprocessing the stripped copy.

**In the demo,** KYC attachments are transferred to a folder on the demo volume but the stored email is **not**
replaced. Replacing it would change what the recorded model replies were made from. A real deployment always replaces.

## What you still need to decide

- Whether five years suits your obligations. Change `retention.messages_days` and `retention.directory_days` if not.
- How long your **backups** keep data. Retention deletion does not reach backups. A restored backup brings back data
  that has since been deleted, and the next daily run deletes it again if it has expired.
- Retention at your KYC target. Once a file is transferred, it is outside this app.

## Removing a Gmail mailbox's credential

Removing a mailbox from the configuration stops collection but keeps its stored refresh token. To end the access as well:

1. Revoke the app's access in the Google account of that mailbox (the account's security settings, third-party access).
   The stored token then no longer works.
2. Delete the stored row as the database owner (the app's own role cannot delete it):

   ```sh
   docker compose exec db psql -U postgres -d doi -c "DELETE FROM mailbox_credential WHERE mailbox_id = '<mailbox id>'"
   ```

   The encrypted token it referred to is removed by the next daily clean-up.
