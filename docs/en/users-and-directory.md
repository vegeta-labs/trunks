# Users and directory

**This version has no screen for users or for the directory.** An admin manages both through the app's HTTP API
with `curl`, from a terminal on any machine that can reach the app. The commands on this page are run by the
Compose test exactly as written here (test plan TC-OPS-08).

You need:

- `curl` 7.87 or later (for `--url-query`). Ubuntu 24.04 and current macOS have it.
- An admin account whose first password has already been changed (see [Quick start §2.5](quickstart.md#25-first-sign-in)).
  Until then every request except the password change is refused. The change is made in a browser. On a server
  without one and without HTTPS yet, forward the port first (`ssh -L 8080:127.0.0.1:8080 <server>`) and open
  `http://127.0.0.1:8080` on your own machine.

If you sign in with OIDC (`auth.oidc`), users are created at their first sign-in with the role your identity provider
gives them, and you do not need section 2. You still import the directory (section 3).

## 1. Sign in from the terminal

Run these in an empty working directory. The cookie file holds your session, so it is created readable only by you
and deleted at the end (section 4).

<!-- tested: run -->
```sh
DOI_URL=https://inbox.capital.example
umask 077
printf 'admin user name: '; IFS= read -r DOI_USER
printf 'password: '; IFS= read -rs DOI_PASS; echo
printf '{"username":"%s","password":"%s"}' "$DOI_USER" "$DOI_PASS" |
  curl -sS --fail-with-body -c doi-cookies.txt -o /dev/null -H 'content-type: application/json' --data-binary @- "$DOI_URL/api/login"
unset DOI_PASS
CSRF=$(curl -sS --fail-with-body -b doi-cookies.txt "$DOI_URL/api/csrf" | sed -E 's/.*"csrf":"([^"]*)".*/\1/')
```

- Set `DOI_URL` to your app's address. On the host itself without the proxy it is `http://127.0.0.1:8080` (or your
  `DOI_PORT`).
- Passwords are typed at a prompt and sent on curl's standard input, so they never appear in the shell history or in
  the process list (`ps`), where other users of the same machine could read them. The `x-csrf-token` header does show
  in the process list; it is useless without the session cookie, which only you can read.
- A password that contains `"` or `\` breaks the JSON body. Choose passwords without them.
- `curl: (22) … 401` means a wrong user name or password; `403` with `change your password first` means the first
  password has not been changed yet.
- Every request that changes something needs the `x-csrf-token` header with `$CSRF`. Without it the app answers `403`.

## 2. Users

There are three roles. Each one can do everything the role before it can:

| Role | Can |
|---|---|
| `reviewer` | work Cases, edit and approve replies, tick verification checklists |
| `approver` | also approve verification tasks, lower risk, set the hold flag |
| `admin` | also manage users, import the directory, retry KYC transfers |

Define a small helper once in your terminal. It asks for the new user's name, role and first password:

<!-- tested: run -->
```sh
new_user() {
  printf 'new user name: '; read -r U
  printf 'role (reviewer, approver or admin): '; read -r R
  printf 'first password (12 characters or more): '; IFS= read -rs P; echo
  printf '{"username":"%s","role":"%s","password":"%s"}' "$U" "$R" "$P" |
    curl -sS --fail-with-body -b doi-cookies.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
      --data-binary @- "$DOI_URL/api/users"
  echo; unset P
}
```

Then run it once per person, for example a reviewer and an approver:

<!-- tested: run -->
```sh
new_user
new_user
```

- **Choose a new random first password for each person**, for example with `openssl rand -base64 18`. Never reuse
  a password from an example, a ticket or an email: anyone who knows it can sign in first and choose their own new
  password.
- The answer is `{"id":"…"}`. **Write the id down**: there is no list of users in this version, and the role change
  and password reset below need it.
- The password must be at least 12 characters. Give it to the person by a channel other than email. They must change
  it at their first sign-in.
- A user name that already exists is refused (`username taken`).

Change a user's role, or reset a user's password (the user must change it again at the next sign-in, and all their
sessions end):

```sh
curl -sS --fail-with-body -b doi-cookies.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -X PUT --data '{"role":"approver"}' "$DOI_URL/api/users/<id>/role"
printf 'new first password: '; IFS= read -rs P; echo
printf '{"password":"%s"}' "$P" | curl -sS --fail-with-body -b doi-cookies.txt -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' --data-binary @- "$DOI_URL/api/users/<id>/reset"; unset P
```

### Users and two-person control

Account history decides who may approve a verification task (bank-detail and identity changes; see
[Security model §7](security-model.md#verification-tasks-and-two-person-control)). Plan your users with these rules in
mind:

- The person who ticks the checklist and the person who approves must be two different users.
- Neither of the two may have created the other's account, granted the other a role or reset the other's password.
  So the admin who created a reviewer's account cannot approve that reviewer's tasks. Let the first `admin` create
  the accounts, and give the approver role to people whose accounts that admin created.
- Both accounts, and their current roles, must be older than one cooling-off period (default 24 hours) at the moment
  the checklist is done. **On a new deployment the first approval is therefore possible only after about two
  cooling-off periods** (default about 48 hours): one for the accounts to age, and one for the task's own cooling-off.
  A role change or password reset starts the waiting time again for that user.

## 3. Directory

The directory is what the app links emails to: your deals, the commitments of each deal, the bank lines and ledger
of each deal, and your contacts. You import it as CSV files. Files exported by Goten — Deal Calculations, the companion browser tool in Vegeta, import unchanged, except a file without data rows,
which is refused (see below).

- Each import is a **new version** of that list. It replaces the current version of the same kind (for commitments,
  bank lines and ledger: of the same deal). Nothing is merged, so always import the complete list.
- A file with any error is refused as a whole, and the answer lists every error with its row number, for example
  `{"ok":false,"errors":[{"where":"row 3, currency","message":"\"CHF\" is not one of GBP, EUR, USD"}]}`.
- A successful import answers `{"ok":true,"versionId":"…","rows":2}`.
- A file with a header and no data rows is refused (`no data rows`), and the current list stays as it was. The usual
  cause is `--data` instead of `--data-binary` (see below). To empty a list on purpose, see
  [Emptying a list](#emptying-a-list).
- Each Case keeps the directory version it was linked with. An email that arrived before your import is linked to the
  new version only when a person clicks "Relink with the latest directory" on its Case page.
- Import the deals first. Commitments, bank lines and ledger name their deal, and the deal must exist.

### File formats

Comma-separated, with a header row. Column names are matched without regard to case, and the alternatives in
brackets are accepted too. Other columns are ignored. Dates are `YYYY-MM-DD` or `DD/MM/YYYY`. Amounts are in the
deal's currency, for example `10000.00`, `10,000` or `£10,000.00`.

| File | Columns (**required** in bold) | Notes |
|---|---|---|
| Deals | **`name`** (`deal`, `deal name`), **`currency`** (`ccy`), `close_date` (`planned_close_date`, `planned close`), `reference_prefix`, `receiving_accounts` | `currency` must be one of `deployment.currencies`. A name cannot contain `::`. |
| Contacts | `contact_id` (`id`), **`name`**, **`email`**, `phone`, **`role`**, `deal`, `investor_id`, `authorised_for` | `role` is one of `investor`, `lead`, `company`, `seller`, `adviser`, `other`. `email` and `deal` may hold several values separated by `;`. `investor_id` and `authorised_for` hold commitment keys `<deal name>::<investor_id>`, several separated by `;`; a bare id without the deal name is an error. `phone` is the number on file that verification tasks tell you to call. A `deal` name is not checked against the deals list. |
| Commitments (per deal) | `investor_id` (`id`), **`name`** (`investor name`, `investor`), `email`, **`reference`** (`payment reference`, `ref`), **`cash_due`** (`cash due`, `amount due`, `expected`), `scheme` | The Goten commitments file. |
| Bank lines (per deal) | `transaction_id` (`id`, `transaction id`), **`date`** (`value date`, `booking date`), **`amount`** (`credit`, `paid in`), `payer` (`counterparty`, `from`), `reference` (`description`, `narrative`) | Your bank statement export for the deal's account. Shown on Cases only; nothing is changed. |
| Ledger (per deal) | `transaction_id`, **`date`**, **`amount`**, `payer`, `reference`, **`status`**, `investor_id`, `investor_name`, `decided_by`, `withdrawn_on`, `currency` | The Goten reconciliation export, exact column names. Rows with status `auto` or `confirmed` count as received. An empty `currency` means the deal's currency. A negative amount, or two different rows with the same `transaction_id`, is an error. |

`receiving_accounts` lists the accounts a deal collects into, separated by semicolons. Values need not be IBANs; an
IBAN-shaped value with a bad check digit is an error. Only an admin can import it, and only a keyed hash and the last
four characters are stored. Email content never reaches this list. Without it, an account in an MT103 or pacs.008 attachment
counts as a possible change of bank details. See `docs/en/payment-messages.md`.

Without an id column, contacts, commitments and bank lines get a stable id from the file version and the row number.
A repeated id is an error.

The access rule for replies comes from the contacts file: a reply that shows record data (amounts, ledger status) is
used only when the sender is authenticated and the commitment is in that contact's `investor_id` or `authorised_for`
list. Otherwise the app uses generic replies only.

### Example files

These fictional files are the ones the test imports.

<!-- tested: file deals.csv -->
```csv
name,currency,planned_close_date,reference_prefix
Northwind Robotics,GBP,2026-11-20,NW
```

<!-- tested: file contacts.csv -->
```csv
contact_id,name,email,phone,role,deal,investor_id,authorised_for
C001,Amelia Hart,amelia@hartfamily.example,+44 7700 900101,investor,Northwind Robotics,Northwind Robotics::001,
C002,Grace Whitfield,grace@whitfield-advisers.example,+44 20 7946 0150,adviser,Northwind Robotics,,Northwind Robotics::001
```

<!-- tested: file commitments.csv -->
```csv
investor_id,name,email,reference,cash_due,scheme
001,Amelia Hart,amelia@hartfamily.example,NW-001,10000.00,SEIS
002,Oliver Bennett,oliver.bennett@bennettmail.example,NW-002,25000.00,EIS
```

<!-- tested: file bank.csv -->
```csv
transaction_id,date,amount,payer,reference
T-NW-0001,2026-10-20,10000.00,A HART,NW-001 Hart
```

<!-- tested: file ledger.csv -->
```csv
transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency
T-NW-0001,2026-10-20,10000.00,A HART,NW-001 Hart,auto,001,Amelia Hart,system,,GBP
```

### Import

<!-- tested: run -->
```sh
imp() { curl -sS --fail-with-body -b doi-cookies.txt -H "x-csrf-token: $CSRF" -H 'content-type: text/csv' "$@"; echo; }
imp --data-binary @deals.csv "$DOI_URL/api/directory/deals"
imp --data-binary @contacts.csv "$DOI_URL/api/directory/contacts"
DEAL='Northwind Robotics'
imp --url-query "deal=$DEAL" --data-binary @commitments.csv "$DOI_URL/api/directory/commitments"
imp --url-query "deal=$DEAL" --data-binary @bank.csv "$DOI_URL/api/directory/bank"
imp --url-query "deal=$DEAL" --data-binary @ledger.csv "$DOI_URL/api/directory/ledger"
```

### Emptying a list

An import never empties a list by accident. To empty one on purpose, for example after importing a ledger into the
wrong deal when the right deal has no ledger yet, send a file with the header only **and** `clear=yes`:

<!-- tested: run -->
```sh
printf 'transaction_id,date,amount,payer,reference,status,investor_id,investor_name,decided_by,withdrawn_on,currency\n' > empty-ledger.csv
imp --url-query "deal=$DEAL" --url-query clear=yes --data-binary @empty-ledger.csv "$DOI_URL/api/directory/ledger"
```

The answer is `{"ok":true,…,"rows":0}`; the audit chain records the import as a clear. A cleared ledger counts as
no ledger: Cases show "No ledger imported for this deal", as before the mistaken import. `clear=yes` with a file that
has data rows is refused, so it can never import anything by mistake. Cases that arrived before keep the version
they were linked with (use "Relink with the latest directory" on a Case to move it to the emptied list).

Use `--data-binary`, not `--data`: `--data` removes the line breaks and the file arrives as one line. For each further
deal, set `DEAL` to its name exactly as in the deals file and import its three files.

## 4. Sign out

<!-- tested: run -->
```sh
curl -sS --fail-with-body -b doi-cookies.txt -H "x-csrf-token: $CSRF" -X POST -o /dev/null "$DOI_URL/api/logout"
rm doi-cookies.txt
```

Every step is recorded in the audit chain with the admin who made it (`user.created`, `directory.imported`, …).
