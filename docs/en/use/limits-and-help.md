# Limits and help

Trunks reads email and helps you prepare a response. People decide and act.

## What Trunks does not do

- It does not send email or create drafts in your mail client. Trunks keeps reply drafts itself, and you send every reply from your own mail client.
- It does not move money or connect to a bank.
- It does not change your records. It never updates Goten or your ledger, and nothing in an email changes your directory or applies new bank details or contact details.
- It does not verify anyone. It only tells you what to check.
- It does not confirm that money has arrived. Only your imported ledger can show that. A case uses the ledger as it stood when the email arrived or when the case was last relinked, so an older case can show an out-of-date position. Use **Relink with the latest directory** first.
- It does not track what you sent. **Mark as sent** is a person's statement.
- It does not reopen a closed case. If a case was closed by mistake, handle the email outside Trunks, or wait for the sender's next email.
- It does not give legal, tax, compliance or investment advice. It is software, not a regulated service.

Trunks can be wrong. A language model helps pick the email type and pull out key details, and fixed rules do the rest. Either can miss something. A person remains responsible for every reply and every risk decision, and a low risk rating is not a clearance.

## When Trunks is wrong or unavailable

| What happened | What to do |
|---|---|
| Wrong email type | Correct it under **Email type**. See [Read a case](reading-a-case.md#2-check-the-email-type). |
| Wrong amount, date or reference | Use **Edit** under **Key details**. Once a value is confirmed or saved, **Edit** is no longer offered: ask your admin to correct it. |
| Linked to the wrong deal or person, or not linked | Pick from the menu next to the link if there is one. If not, your directory may be out of date: ask your admin to import a new one, then click **Relink with the latest directory**. |
| Wrong risk | Raise it under **Set risk**. To lower it, ask an approver. |
| The reply is wrong for this email | Edit it or choose another template. If nothing fits, click **Reject** and write your own reply from your mail client. |
| A case shows **Processing failed** | The page says **Processing failed. Results may be incomplete. Ask an administrator to retry.** Nothing is lost. Work from the original email in your mailbox if it cannot wait. |
| **Cases could not be loaded. Try again.** or **This case could not be loaded.** | Reload the page. If it keeps happening, tell your admin. |
| A warning banner at the top of the page, for example **KYC attachment transfer has failed** or a mailbox warning | Tell your admin. |
| An email you expected is not in the list | The list shows 50 cases to a page, including closed ones, with the highest risk first. Use **Next** to see later pages, or filter by **Status** and **Queue**. If it is still missing, your admin can check the mailbox connection. |
| Trunks is down | Handle urgent email directly in your mailbox. Trunks only reads your mail, so nothing is held up inside it. Be extra careful with bank details and identity changes, and use the same call-back on the number on file. |

## After an upgrade to v0.4.0

Version 0.4.0 adds the closing rules and the other checks described in these pages. The first time it starts:

- Every reply that was approved but not marked as sent goes back to **Draft**. Its case goes back to **Open**, unless the case is closed. Read the reply and approve it again.
- For a reply from before the upgrade, everyone who created any reply on that case counts as having changed its text, even someone who only switched templates. Such a reply needs an approver or admin who is none of them.
- Every verification task from before the upgrade is cancelled, including approved ones. On a closed case, the task is not replaced and the case stays closed. An open case that had finished processing is processed again and gets a new task. Do the checklist, the cooling-off period and the second-person approval again.
- A **Bank details** or **Identity change** type removed before the upgrade counts again, and the case gets a new task, unless all of these hold: it was removed with a reason, the person who removed it is still an approver or admin, and their role has not changed since.

## Your data

- **Cases CSV** and **Actions CSV** on the list page download the cases and suggested actions.
- By default, an email and its case are kept for 5 years from when it arrived. An approver can keep a case longer with a **Retention hold**. See [Retention](../retention.md).
- A language model may see the redacted subject, text and sender display name of an email, the redacted text of its attachments, and each attachment's name and type, to classify it and extract details, depending on how your team set it up. It does not see the contents of a **Possible KYC document**, though it does see that file's name and type. See [Models and data protection](../models-and-data-protection.md).

## Who to ask

| Question | Ask |
|---|---|
| Is this reply right? Is this email genuine? | Your team lead or compliance contact |
| Can we go ahead with this bank details or identity change? | An approver, after the verification task is done |
| Please lower this risk, or put this case on hold | An approver |
| I cannot sign in, or I need a different role | Your admin. See [Users and directory](../users-and-directory.md). |
| A KYC transfer failed | Your admin |
| A case failed, a deal or contact is missing, or a mailbox has stopped | Your admin. See [Quick start](../quickstart.md#27-cases-that-fail) and [Mailboxes](../mailboxes.md). |
| How is our data protected? | Your admin. See the [Security model](../security-model.md). |
