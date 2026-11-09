# Accounts in payment messages

An IBAN or UK account in an attachment normally adds the `bank_details` label: the reply is limited to `safe_ack`, and
a verification task opens. A structurally valid MT103 or pacs.008 is the exception, when every condition below holds.
The account fields then do not count as a change of bank details.

The attachment:

- is a top-level plain text MT103 or XML pacs.008, with no other attachment except an inline signature image;
- passes the strict structure check, and every account sits in the payer or beneficiary account position;
- has no change-of-account wording elsewhere, and no long numbers in its free text;
- names only beneficiary accounts listed in `receiving_accounts` for the deal.

The mail:

- comes from an authenticated sender with all signals clear, who is involved in one deal only;
- has no account or redirect wording in the subject, body or file names;
- has model labels limited to payment query and payment evidence;
- belongs to a Case that has never had the `bank_details` rule label.

If a condition fails, the account counts as it did before. That includes a bank's printed PDF, an MT103 pasted into the
body, a deal with no `receiving_accounts`, an unauthenticated sender and an investor in several deals.

## Rules that only raise the risk

- A structurally valid message whose beneficiary account position is not on the linked deal's list raises the risk to
  high, adds `bank_details` and opens a verification task. The same happens when the exception applied and the Case is
  then linked to another deal, or to none.
- A mail with an MT103 or pacs.008 amount also gets `bank_details` for change wording in the subject, or for an explicit
  redirect such as "from now on" or "going forward", even with no account in the attachment. Ordinary mail that uses
  these words alongside a confirmation gets the label too.
- Once a Case has the `bank_details` rule label, it keeps it through re-runs, relinks and directory changes.

## Known limits

- Images are not read, so an account drawn in an image is not seen.
- Payer accounts cannot be checked against a list.
- Wording can avoid the word list in any language, including letters that only look Latin and words written wholly in
  another script. If the model does not recognise it either, a request to redirect a payment or refund is not caught.
- Numbers kept short or split enough to pass the structure check, or written in a reference field, a message header or a fixed format field such as an amount or exchange rate (`:33B:`, `:36:`, `:71F:`, `XchgRate`, `CtrlSum`), are not caught.
- A beneficiary with no account line, only a name, has nothing to compare.

Account values with an IBAN or UK shape are replaced by a placeholder before any model call, and so are values in an
account position with six or more digits, whether or not this exception applies. A confirmation is the sender's document
and never counts as receipt.

The account position rule applies to mail parsed after the upgrade. Older Cases keep the masking they were processed with.
