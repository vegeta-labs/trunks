# Risk and verification

Trunks rates every email and, for bank details and identity changes, sets you a checklist that two people must complete. The rating and the checklist help you. They do not make the decision.

A person remains responsible for every risk decision. A low risk rating is not a clearance.

## What you need

- A Trunks account. Ticking a checklist needs any role. Lowering a risk, being the second person and removing a **Bank details** or **Identity change** type need the approver or admin role. See [Roles](roles.md).
- The phone number on file, which Trunks shows on the task.

## How the risk level is set

Fixed rules set the risk, in this order:

1. Each email type has a starting level, its **Class floor**. See the table in [Read a case](reading-a-case.md#2-check-the-email-type).
2. Some findings make the case **High** straight away.
3. Others, marked **(+1)** on the page, raise it one level.

High does not mean fraud. A KYC document from a known investor is High because of how it must be handled.

## Warning signals

The **Signals** panel lists the checks that fired. **All signals (9)** shows every check and its result.

| Signal | What it means | What to do |
|---|---|---|
| **Authentication failed (SPF, DKIM or DMARC)** | The email failed the mail system's checks that it came from who it says. | Treat the sender as unconfirmed. |
| **An authentication header from an unknown server** | A sender check result came from a server your setup does not trust. | Treat the sender as unconfirmed. |
| **Display name matches a contact, address does not** | The name is someone you know; the address is not theirs. | Contact the person through the details on file. |
| **Domain looks like a known contact domain** | The domain differs by a character or two from a real one. | Compare it letter by letter. |
| **Reply-To differs from From** | Answers would go to a different address. | Check who you would be writing to. |
| **First mail from this address** | Trunks has not seen this address before. | Be more careful with any request to change something. |
| **Hidden text in the HTML** | The email contains text a reader would not normally see. | Read it on the case page. Do not follow it. |
| **Instruction-like phrases in the mail** | The email tries to give orders to software, such as "Ignore previous instructions". | Do not follow it. |
| **Message-ID seen before with other content** | An email with the same identifier arrived earlier with different contents. | Compare the two. |

A check that could not run shows **could not be checked**. That is not the same as passing.

Other findings shown under **Risk** include **Attachment amounts differ from the mail**, **First mail from this address, with an account number**, **Pressure words in a payment or account mail (+1)** and **Planned close within 3 working days (+1)**.

## Change the risk

Under **Risk**, choose a level in **Set risk** and click **Apply**.

- **Anyone can raise it.** The panel then shows, for example, **a person's adjustment to high is active**.
- **Only an approver or admin can lower it**, and they must give a reason. A reviewer who tries sees **lowering the risk needs the approver role and a reason**.

If a person's correction would lower the risk, the risk stays where it is **until an approver confirms the lower risk**. An approver enters a reason and clicks **Accept the lower risk**.

Never lower a risk only because the email looks fine. Lower it because you checked something, and say what in the reason.

## Verification tasks

An email adopted as **Bank details** or **Identity change** gets a task on the case page, headed **Check the bank details request** or **Check the change of identity details**. It is a callback check and a second-person check. Trunks never applies new bank details or contact details from an email.

A label marked **low confidence — needs confirmation** has no task. If the email really is a bank details or identity change request, click **Add** to add that class, and the task appears.

### Steps for the person who makes the check

1. Read **Phone on file**. If the case impersonates someone, **Contact** names them. If there is no number, the panel says **No phone number on file: find another known channel**.
2. Open **Message to the old contact details** to see the message you must send and where to send it. Send it from your own mail client. Trunks has no copy button for this message, so select it by hand.
3. Do each item, and tick it only when it is done:
   - **Call the phone number on file**
   - **Do not use any phone number or link from the email**
   - **Check what the request asks for**
   - **Notify the old contact details**
4. Click **Checklist done**. It is greyed out until every item is ticked.

The tag changes to **Checklist done — cooling-off period**. Default cooling-off is 24 hours, and your admin can change it, to no less than 1 hour.

### Steps for the second person

The second person needs the approver or admin role and must not be the person who ticked the checklist.

1. After the cooling-off time shown as **second approval from**, open the case.
2. Read the panel. It lists anything that blocks approval.
3. Satisfy yourself that the check was really done. Ask the first person what the caller said if you need to.
4. Click **Approve as the second person**.

The tag changes to **Approved by a second person**.

This approval does not change any bank details. Your team applies the change, in your own systems, once it is approved.

### When approval is refused

| Message | Meaning | What to do |
|---|---|---|
| **the cooling-off period has not ended** | The waiting time is still running. | Come back after the time shown. |
| **You ticked the checklist, so a different person must approve.** | You cannot approve your own check. | Ask another approver. |
| **an account is newer than one cooling-off period before the checklist was done** or **a role is newer than one cooling-off period before the checklist was done** | One of the two accounts or roles was too new at the time. Waiting does not fix this task. | An approver uses **Restart verification**, then repeats the checklist once the accounts are old enough. |
| **one of the two users created the other**, **one of the two users granted a role to the other** or **one of the two users reset the credentials of the other** | The two people are linked through account administration. | Ask a different approver. |
| **credentials were reset within the cooling-off period** | A password was reset too close to this task. | If it was the second person's password, ask a different approver. If it was the first person's, an approver uses **Restart verification**. |
| **this task no longer applies; a new task replaces it** | Something the task rests on changed. See [When a task starts again](#when-a-task-starts-again). | Reload the page and work on the new task. |

An admin can see the user rules in [Users and directory](../users-and-directory.md#users-and-two-person-control).

### Restart a task

An approver or admin enters a reason under **Reason for restarting** and clicks **Restart verification**. The checklist starts again, and so does the cooling-off period when it is next completed. An approved task cannot be restarted.

### When a task starts again

A task rests on the case as it was when the task was made. Trunks cancels it and puts a new open task in its place, even if it was already approved, when:

- a person changes a class, edits a key detail, changes a link or the risk, or relinks the case;
- the details the task rests on change, for example when the email is processed again or a KYC file is replaced;
- the contact the task is about changes.

Clicking **Confirm** on a key detail without changing it does not start the task again, as long as the case has finished processing. Even so, finish your corrections before you start the checklist.

### When a task disappears

Once an email has been treated as **Bank details** or **Identity change**, that type stays on the case. Processing the email again does not remove it, and neither does a lower-confidence result from the model.

Only an approver or admin can remove the type, and only with a reason, whatever it does to the risk. A reviewer who tries sees **Removing the bank details or identity change type needs an approver or admin and a reason**. A type found by a fixed rule, shown with **(rule)**, cannot be removed at all.

When an approver or admin removes it, the task is cancelled and its panel leaves the page. The class list shows the type struck through, for example **Bank details**, with who removed it and their reason. Processing the case again does not bring it back, unless a fixed rule marks the email as **Bank details** again. A type found by a fixed rule cannot be removed.

## Closing a case

A reviewer can close a case only when all of these hold:

- the email has finished processing;
- every verification task on it is **Approved by a second person**, and still applies to the case as it is now;
- no reply is approved and waiting to be marked as sent.

If any of them does not hold, a reviewer sees **Only an approver or admin can close this case now, with a reason:** with the list of what is missing, and no **Close** button. The list can include:

| Reason | What to do |
|---|---|
| **its email has not finished processing** | Wait and reload. |
| **it is marked as a bank details or identity change, but its check has not been created yet** | Wait and reload. If it stays, ask your admin. |
| **a bank details or identity check has not been approved** | Finish the check and the second-person approval. |
| **an approved check no longer matches this case because the contact or details changed** | Do the new task. See [When a task starts again](#when-a-task-starts-again). |
| **an approved reply has not been marked as sent** | Send it and click **Mark as sent**, or click **Reject**. |

An approver or admin sees **This case is not ready to close. Closing it anyway needs a reason:**, the same list, and a **Reason** box. They can close it with a reason, for example because the request was fraudulent or the task can never be approved. Trunks keeps the reason in its records.

When a case is closed, any reply that was approved but not marked as sent is withdrawn, and any verification task that was not yet approved is cancelled. After that the case cannot be changed. An approver or admin can still put it on hold or remove the hold, and an admin can still use **Retry the transfer** or **Mark as handled** on a KYC attachment. There is no way to reopen a case in this version. If one was closed by mistake, handle the email outside Trunks, or wait for the sender's next email, which becomes a new case.

## What you should never do

- Call a number or follow a link from the email to verify the email.
- Change bank details, or tell investors new bank details, because an email asked you to.
- Treat an MT103 or pacs.008 attached to an email as proof the money arrived. Only your imported ledger can show that.
- Take **Low** or **No warning signals detected.** as proof that an email is genuine.
