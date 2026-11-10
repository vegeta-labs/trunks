# Walk the demo

Sign in to the Trunks demo, read the inbox, deal with one case from start to finish and see how a bank details request is checked. The demo holds 31 emails, most of them about the Northwind Robotics deal.

## What you need

- A modern browser.
- A running demo. An admin starts it by following [Quick start](../quickstart.md#1-the-demo). On the computer that runs it, the address is http://127.0.0.1:8080.

When your admin resets the demo, by starting it again from the beginning as in [Quick start](../quickstart.md#1-the-demo), everything you did is removed. If only the app restarts, your work stays. The figures on this page are for a freshly reset demo. Times are shown in your browser's time zone, so yours may differ.

The emails keep their original dates, so many deadlines show as overdue.

## Steps

### 1. Sign in

1. Open the demo. The page is headed **Trunks — Operations Inbox**.
2. Under **Demo accounts**, click **reviewer**. The username and password fill in.
3. Click **Sign in**.

The top of the page now shows **demo-reviewer (reviewer)**, with **Sign out** beside it.

### 2. Read the inbox

The page is headed **Cases** and shows **Showing 1–31 of 31 cases**. Cases are **Sorted by risk, then due time**, 50 to a page. When there are more than 50, use **Previous** and **Next** at the bottom of the list. Each row has the subject, the sender, the mailbox, when the email arrived and a row of tags: risk, status, queue, due time and any warning signals.

Use the filters at the top:

1. Set **Risk** to **High**. The count changes to **Showing 1–16 of 16 cases**.
2. Set **Queue** to **Compliance**. The count changes to **Showing 1–6 of 6 cases**.
3. Click **Clear filters**.

### 3. Open a simple case

Click **Northwind Robotics payment - has it arrived?**, from Amelia Hart.

The email is on the left and the panels you work with are on the right. At the top you see:

| Label | Value |
|---|---|
| Status | Open |
| Risk | Medium risk |
| Due | 26 Oct 2026, 11:14 |
| Next step | Check Amelia Hart's payment in the ledger (NW-001) |

Under **Related records**, Trunks has matched the email to your records:

| Label | Value |
|---|---|
| Sender | Amelia Hart (C001), **authenticated sender** |
| Commitment | Amelia Hart · NW-001 |
| Deal | Northwind Robotics |
| Ledger | Paid in full · Imported Goten ledger |
| Possible bank lines | T-NW-0001 (auto) |
| Record data in replies | allowed |

The ledger comes from your imported records, not from the email. That is why the reply below may say the money has arrived.

### 4. Check and approve the reply

Scroll to **Reply**. The draft is tagged **Payment received** and **Draft**. It goes to amelia@hartfamily.example with the subject **Your payment for Northwind Robotics**, and it says:

> Dear Amelia Hart,
>
> We have received GBP 10,000.00 for Northwind Robotics (reference NW-001). Your commitment of GBP 10,000.00 is paid in full.
>
> Kestrel Syndicate Operations

The amounts match the email and the ledger. Click **Approve**.

The reply is now tagged **Approved, waiting to be sent by a person**, and the status at the top of the case changes to **Approved — awaiting manual send**. Three new buttons appear.

### 5. Copy it and mark it as sent

1. Click **Copy recipient**. **Copied the recipient.** appears under the buttons.
2. Click **Copy subject**, then **Copy text**. In real use you paste each one into a new message in your own mail client and send it from there. In the demo, do not send anything.
3. Click **Mark as sent**.

The status changes to **Marked as sent**. Trunks cannot send email. **Mark as sent** only records that a person says they sent it.

### 6. Close the case

Under **Queue and owner**:

1. Open **Close with outcome…** and choose **replied**.
2. Click **Close**.

The panel shows **Closed: replied**, and the status at the top is **Closed**.

### 7. See a bank details request

Click **← All cases**, then open **Northwind Robotics - change of bank account**, from Ethan Clarke.

Look at the sender address, ethan.clarke@northwind-robotlcs.example, and the letter after "robot". It is a lower-case L, where the real address, ethan.clarke@northwind-robotics.example, has an "i". The name is right and the domain is not.

Trunks shows **High risk**. Under **Risk** it lists why:

- Display name matches a contact, address does not
- Look-alike domain
- First mail from this address, with an account number
- Pressure words in a payment or account mail (+1)

A panel headed **Check the bank details request** tells you to call the number on file, +44 20 7946 0142, and not to use any number or link from the email.

Under **Reply**, Trunks says **This sender's name or domain imitates a known contact, so this reply has no allowed recipient.** The prepared reply is a fixed acknowledgement with no address in **To**, and it cannot be approved. [Check and send a reply](checking-a-reply.md#check-the-recipient) explains why.

Under **Queue and owner**, there is no **Close** button. Trunks says **Only an approver or admin can close this case now, with a reason:** and lists **a bank details or identity check has not been approved**.

### 8. Try the two-person check

In real use, you tick these boxes only after you have made the call and done each thing. In the demo, go ahead and tick them.

1. Tick all four items in **Check the bank details request**.
2. Click **Checklist done**. The tag changes to **Checklist done — cooling-off period**.
3. Click **Sign out**.
4. Under **Demo accounts**, click **approver**, then **Sign in**.
5. Open the same case and click **Approve as the second person**.

Trunks refuses, with **the cooling-off period has not ended**. The panel also shows that the demo accounts are too new to approve this task. Waiting does not fix this task, because account age is measured at the moment the checklist was done. A successful approval needs the demo left running until the accounts are at least 24 hours old, then **Restart verification**, the checklist again, and another 24-hour cooling-off period. Resetting the demo creates the accounts again, so they are new once more. See [Risk and verification](risk-and-verification.md).

## When you are finished

Click **Sign out**. Ask your admin to reset the demo if you want to walk it again from the start. To learn the daily work, go on to [Read a case](reading-a-case.md).

## When it goes wrong

| What you see | What to do |
|---|---|
| **wrong username or password** | Click the role button under **Demo accounts** again, so that the details fill in for you. |
| Every case shows **Processing** | The demo is still reading its emails. Wait a minute or two and reload. |
| **No cases match these filters.** | Click **Clear filters**. |
| **Approve** stays greyed out | The reply text has unsaved changes, or the case is being updated. See [Check and send a reply](checking-a-reply.md#when-it-goes-wrong). |
| **Copy failed: select the text below and copy it by hand.** | Your browser refused the copy. Select the text in the box that appears and copy it yourself. |
| Different figures from this page | Someone has already worked in this demo. Ask your admin to reset it. |
