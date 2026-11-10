# Check and send a reply

Trunks prepares a reply from a fixed template. You check it, approve it, copy it and send it from your own mail client. Trunks never sends email.

A person remains responsible for every reply. Approving one means you have checked it and you stand behind it.

## What you need

- A Trunks account with any role. On a reply, **Approve** does not need the approver role, unless someone changed the text. See [Roles](roles.md).
- Your own mail client, signed in to the mailbox you normally reply from.
- You have read the case. See [Read a case](reading-a-case.md).

## Steps

### 1. Read the draft

Go to **Reply** on the case page. Each draft shows the template, its status, **To**, **Subject** and the text.

Check four things:

1. **The recipient.** See [Check the recipient](#check-the-recipient).
2. **Every name, amount and reference.** Compare them with the email and with **Related records**. Trunks fills them in from your records and from details a person confirmed, never from the words of the email.
3. **That it answers this email.** Trunks chooses the template by fixed rules, and a rule can still pick the wrong one for what the sender really asked.
4. **That it says nothing it should not.** A line telling someone their money has arrived must be backed by the ledger.

If the draft says that a sentence was **left out because a value is missing**, Trunks removed it. Decide whether the reply still works without it.

Some cases have no reply. The panel then says **No reply is drafted for this Case.**, as on the newsletter in the demo. Close it when you are done.

### 2. Fix it if needed

| You want to | Do this |
|---|---|
| Change the words | Edit the text and click **Save text**. Trunks does not check what your wording discloses, so do not add amounts, names or deal details unless the sender is entitled to them. An edited reply needs a second person to approve it. See below. |
| Use a different template | Choose from **Use another template…**, for example **Request a payment reference** or **Acknowledge complaint**. |
| Change the recipient | If the case has another allowed address, choose it from **To**. |
| Drop the draft | Click **Reject**. |

- **This reply's text is fixed and cannot be edited.** appears on the plain acknowledgement. Bank details, identity changes and every **High** risk case always get this reply, and no other template is offered for them.
- After you choose another template, two drafts can appear: yours, tagged **chosen by a person**, and the one the rules prepared. Reject the one you do not want, so nobody approves it by mistake.
- Once you change the text, the draft says **The text was changed from the template, so it needs approval from an approver or admin who did not change it.** Ask an approver or admin to approve it who did not change the text, and who has no account link with anyone who did: they must not have created that person's account, given them a role or reset their password, and that person must not have done any of these for them. Each copy and **Mark as sent** check this again against the person who approved. Choosing another template is not a change to the text. If you change the text back to the template's words, any role can approve it again.
- Trunks blocks words that would give away what it suspects, such as "fraud", "suspicious", "flagged" or "verification task". If you use one, you see **Internal wording not allowed in a reply: suspicious** and the reply cannot be approved until you remove it.

### 3. Approve

Click **Approve**. Trunks checks the reply again first, and refuses if it no longer fits the case. The reply is tagged **Approved, waiting to be sent by a person**, and the case status changes to **Approved — awaiting manual send**. **Copy recipient**, **Copy subject** and **Copy text** appear.

### 4. Copy it and send it from your own mail client

1. Start a new message in your mail client, or reply in the original thread if your team does that.
2. Click **Copy recipient** and paste it into the To field, replacing anything already there. A mail client's Reply can fill in a Reply-To address that Trunks has deliberately not allowed. **Copied the recipient.** confirms it. If the sender is flagged as a look-alike, the reply has a recipient only after an approver or admin allowed the original address. Even then, compare it with the contact on file before you send.
3. Click **Copy subject** and paste it.
4. Click **Copy text** and paste it into the body.
5. Read it once more and send it.

Each copy asks Trunks to check the reply again, with the same checks as **Approve**, so you cannot copy a reply that has become out of date. Anything you change in your mail client after pasting is not checked by Trunks.

### 5. Mark it as sent

After you have sent it, click **Mark as sent**. Trunks checks the reply once more. If the approval still holds, the status changes to **Marked as sent**. If not, the reply goes back to a draft. See [When a reply goes out of date](#when-a-reply-goes-out-of-date).

Trunks cannot see your outbox. **Mark as sent** only records that a person said they sent it, so click it only after you have.

### 6. Close the case

Under **Queue and owner**, choose from **Close with outcome…** and click **Close**. Once closed, the case cannot be changed.

| Outcome | Use it when |
|---|---|
| **replied** | You sent a reply. |
| **no_action** | Nothing needs doing. |
| **forwarded** | You passed it to someone else to handle. |
| **duplicate** | Another case already covers this email. |
| **spam** | It is junk. |

A reviewer can close a case only when it has finished processing, any verification task is approved and still applies, and no approved reply is waiting to be marked as sent. Otherwise only an approver or admin can close it, with a reason. See [Closing a case](risk-and-verification.md#closing-a-case).

## Check the recipient

Trunks normally addresses the reply to the sender of the email.

When the sender's name matches a contact but the address does not, or the domain looks like a known contact's domain, the reply has no recipient. The panel says **This sender's name or domain imitates a known contact, so this reply has no allowed recipient.** The reply cannot be approved. On the look-alike case in the demo, **Northwind Robotics - change of bank account**, the sender is ethan.clarke@northwind-robotlcs.example, which is not the real company address.

Contact the person through the details you already hold, as the verification task tells you to.

If the warning is wrong and the sender is genuine, an approver or admin can enter a reason and click **Allow reply to the original address**. A reviewer sees **An approver or admin can allow replying to the original address, with a reason.** Afterwards the panel says **An approver allowed replying to the original address:** with the reason, and you choose that address from **To**. Only the address the email came from is allowed, never a Reply-To address.

## When a reply goes out of date

If someone changes the case after a reply was approved, that approval stops counting. Trunks checks again when you approve, copy and mark as sent. You will see the old reply tagged **Out of date — work on the current draft** and a new **Draft** above it. The case status goes back to **Open**.

Read the new draft and approve it again. This happens whenever someone changes a class, a key detail, a link or the risk, or relinks the case.

## When it goes wrong

| What you see | What to do |
|---|---|
| **Approve** is greyed out | Click **Save text** if you changed the words. If the page says **Reprocessing after a change…**, wait for it to finish. |
| **Internal wording not allowed in a reply:** | Remove the listed word from the reply, click **Save text** and approve again. |
| **A value is missing**, **No recipient** or **This recipient is not allowed** | The reply cannot be approved as it stands. Check **Key details** and **Related records**, or use a different template. |
| **the sender's name or domain imitates a known contact, so this reply has no allowed recipient; an approver or admin can allow replying to the original address with a reason** | See [Check the recipient](#check-the-recipient). |
| **the text was changed from the template, so an approver or admin must approve it** | Ask an approver or admin who did not change the text. |
| **the text was changed by the person approving it, so a different approver or admin must approve it** | Ask a different approver or admin. |
| **the person approving it and a person who changed the text created, granted a role to or reset the password of one another, so a different approver or admin must approve it** | Ask a different approver or admin, one with no such link to anyone who changed the text. |
| **This case is closed, so it can no longer be changed** | The case was closed and its approved replies were withdrawn. Nothing more can be done on its reply. |
| **Copy failed: select the recipient below and copy it by hand.** | Your browser refused the copy. Select the text in the box that appears and copy it yourself. |
| **the reply is not approved** or **the approval no longer holds:** | The case has changed. Read the current draft and approve it again. |
| You approved or sent the wrong thing | Before sending, click **Reject**. After sending, Trunks cannot recall it: follow up from your own mail client. |
