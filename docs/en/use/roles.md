# Roles

Trunks has three roles. Each one can do everything the role before it can. Your role is shown next to your username at the top of the page, for example **demo-reviewer (reviewer)**.

## What each role can do

| What | Reviewer | Approver | Admin |
|---|---|---|---|
| Read cases, use the filters, download **Cases CSV** and **Actions CSV** | Yes | Yes | Yes |
| Correct **Email type**, **Key details** and links | Yes | Yes | Yes |
| Edit, **Approve**, **Reject**, copy a reply and **Mark as sent** | Yes | Yes | Yes |
| **Approve** a reply whose text someone changed, if you did not change it and have no account link with anyone who did | No | Yes | Yes |
| Raise a risk | Yes | Yes | Yes |
| Tick a verification checklist and click **Checklist done** | Yes | Yes | Yes |
| Move a case between queues, set **Owner**, close a case that is ready to close | Yes | Yes | Yes |
| Close a case that is not ready to close, with a reason | No | Yes | Yes |
| Lower a risk, with a reason | No | Yes | Yes |
| Remove a **Bank details** or **Identity change** type, with a reason | No | Yes | Yes |
| **Allow reply to the original address** of a look-alike sender, with a reason | No | Yes | Yes |
| Click **Accept the lower risk**, with a reason | No | Yes | Yes |
| **Approve as the second person** on a verification task | No | Yes | Yes |
| **Restart verification**, with a reason | No | Yes | Yes |
| **Put on hold** or **Remove the hold** (retention hold) | No | Yes | Yes |
| **Retry the transfer** or **Mark as handled** on a KYC attachment | No | No | Yes |
| Create users, change roles, reset passwords, import the directory, connect mailboxes, rerun failed cases, change settings | No | No | Yes |

The last row has no screen in this version. An admin does these from a terminal or the settings files, using [Users and directory](../users-and-directory.md), [Mailboxes](../mailboxes.md) and [Configuration](../configuration.md).

## Two meanings of "approve"

The word appears twice, and they are different things.

- **Approve** on a reply means "this reply is checked and ready to send". Any role can do it, including the person who drafted it. If someone changed the text from the template, it needs an approver or admin who did not change it. That person must also have no account link with anyone who did: neither created the other's account, gave the other a role or reset the other's password.
- **The approver role** is for a second check on bank details and identity changes, and for decisions that need a reason: lowering a risk, removing a bank details or identity change type, closing a case that is not ready and allowing a reply to a look-alike sender. Clicking **Approve as the second person** needs this role.

## Reviewer

A reviewer does the daily work. They read each case, correct it, handle the reply and tick the checklist on bank details and identity changes after making the call. A reviewer cannot give the second-person approval on a verification task, and cannot lower a case's risk on their own. A reviewer cannot remove a **Bank details** or **Identity change** type, and cannot close a case that is not ready to close. See [When a task disappears](risk-and-verification.md#when-a-task-disappears) and [Closing a case](risk-and-verification.md#closing-a-case).

## Approver

An approver is the second person on verification tasks. They must be someone other than the person who ticked the checklist, and their account has to meet the rules in [Risk and verification](risk-and-verification.md#when-approval-is-refused).

An approver also decides when a risk may be lowered, when a bank details or identity change type may be removed, when a case that is not ready may be closed, and when a reply may go to the original address of a look-alike sender. Each needs a reason. An approver also places a **Retention hold**. A hold keeps a case and the earlier cases in its thread past the normal retention period, for example during a complaint or a dispute. A reason is required both to set and to remove it. A hold can still be set or removed on a closed case. An admin can also still use **Retry the transfer** or **Mark as handled** on a KYC attachment of a closed case. A reviewer sees a hold on a case but cannot change it. See [Retention](../retention.md).

## Admin

An admin looks after the system: users, the directory of deals and contacts, mailboxes and settings. An admin can also do everything an approver can.

An admin account may be blocked from being the second person, too. If an admin created a reviewer's account, that admin cannot approve that reviewer's tasks.

## Get an account

Ask your admin. There are two ways to sign in, depending on how Trunks is set up:

- **Username and password.** You get a first password from your admin by a channel other than email. On your first sign-in the page is headed **Choose a new password**. Enter **Current password** and **New password (12 characters or more)**, then click **Save**.
- **Sign in with your organisation**, if your team uses single sign-on.

New accounts wait before they count for two-person control. On a new deployment, the first verification task can be approved only after about two cooling-off periods, by default about 48 hours.

## When it goes wrong

| What you see | What to do |
|---|---|
| **wrong username or password** | Try again. If you are locked out or forgot your password, ask your admin for a reset. |
| A button in the table above is missing | Your role does not include it. Ask someone with the right role. |
| **your account changed; sign in again** | Your role or password changed. **Sign out** and sign in again. |
