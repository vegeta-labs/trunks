# Mailboxes

Every mailbox is **read-only**.

- The code has no way to send email, write drafts, move, flag or delete messages.
- Every request to Gmail and Microsoft Graph goes through one module. That module allows only a fixed list of
  read-only requests (host, method and path) and never follows redirects.
- A CI check fails the build if the code gains a write or send call, an SMTP client package, or a direct request that
  bypasses the allow-list.

One deployment can read several mailboxes, for example one for operations and one for legal. Cases are routed by
category, not by the mailbox that received the email.

| Kind | `kind` | New mail | Permission |
|---|---|---|---|
| IMAP | `imap` | IDLE plus a catch-up every `catch_up_minutes` | the account you configure; opened read-only |
| `.eml` import | `eml` | a command you run | none |
| Gmail | `gmail` | history polling every `catch_up_minutes`, plus optional Pub/Sub pull notifications | `gmail.readonly`, one consent per mailbox |
| Microsoft 365 | `graph` | delta polling every `catch_up_minutes` | application `Mail.Read`, limited to the designated mailboxes |

**How these were tested.** IMAP was tested against a test IMAP server. Gmail read-only collection was tested on one
personal Gmail account (catch-up polling only). **Microsoft 365 and Gmail Pub/Sub were tested only against simulated
services**, not against a real tenant or a real Pub/Sub subscription.

## Passing mailbox credentials to the containers

The configuration names environment variables (`user_env`, `password_env`, `client_secret_env`, and so on). The app
reads `<NAME>` or, if it is set, the file named by `<NAME>_FILE`. Use Compose secrets for these, in a
`docker-compose.override.yml` next to `docker-compose.yml`. Compose reads that file automatically on `docker compose up`.

Example for one IMAP mailbox:

```yaml
# docker-compose.override.yml
services:
  app:
    environment:
      IMAP_OPS_USER_FILE: /run/secrets/imap_ops_user
      IMAP_OPS_PASSWORD_FILE: /run/secrets/imap_ops_password
    secrets: [imap_ops_user, imap_ops_password]
secrets:
  imap_ops_user: { file: ./secrets/imap_ops_user }
  imap_ops_password: { file: ./secrets/imap_ops_password }
```

Only the `app` service collects mail. Do not give mailbox credentials to `maintenance`.

## Authentication results (all kinds except `.eml`)

The app trusts `Authentication-Results` headers only from a mailbox that you have declared with
`strips_external_auth_results: true`. That setting also needs `trusted_authserv_id`, the authserv-id your own mail
gateway writes.

Declare it only when your gateway removes `Authentication-Results` headers that arrive from outside. Otherwise a
sender could forge a "pass" result. Without the declaration, every email gets the signal "authentication header from
an unknown server", which raises its risk one level, and authentication is shown as "unknown". `.eml` imports never
use authentication results, so for them see [`.eml` import](#eml-import).

## IMAP

```yaml
mailboxes:
  - id: ops
    name: Operations
    kind: imap
    imap:
      host: imap.capital.example
      port: 993
      tls: true
      user_env: IMAP_OPS_USER
      password_env: IMAP_OPS_PASSWORD
      folder: INBOX
    catch_up_minutes: 5
```

- The folder is opened with `EXAMINE` (read-only). The app uses only search and fetch commands, so it does not even
  set the `\Seen` flag.
- One folder per IMAP mailbox.
- **Ask your mail administrator to disable SMTP sending for this account.** IMAP has no read-only permission: an
  account that can read can usually also send through SMTP. The app never sends, but anyone who obtains the password
  could. If SMTP cannot be disabled, record this as a remaining risk in your DPIA.

## `.eml` import

An `eml` mailbox needs no credentials:

```yaml
mailboxes:
  - id: archive
    name: Imported mail
    kind: eml
```

Import files with the `import-eml` command, run inside the app image:

```sh
docker compose run --rm -v "$PWD/mail:/import:ro" app import-eml archive /import/one.eml /import/two.eml
```

- The receive time is the import time.
- Authentication results are never adopted from imported files: authentication is always "unknown" and the sender
  is never an authenticated sender. Most saved emails carry the `Authentication-Results` header of the server that
  received them, and that server is not your trusted one, so such a file also gets the signal "authentication header
  from an unknown server" and its risk goes up one level.
- The same email imported twice creates only one Case.

## Gmail

You need a Google Cloud project with the Gmail API enabled and an OAuth client of type **Desktop app**. For Google
Workspace, an internal app is enough. The app never uses domain-wide delegation: each mailbox is authorised by its own
user, once.

### Configuration

```yaml
gmail:
  client_id_env: GMAIL_CLIENT_ID
  client_secret_env: GMAIL_CLIENT_SECRET
mailboxes:
  - id: deals
    name: Deals
    kind: gmail
    gmail:
      address: deals@capital.example
      labels: [INBOX]
    strips_external_auth_results: true   # only after the check below has passed
    trusted_authserv_id: mx.google.com
    catch_up_minutes: 5
```

- `labels` are label names. They are resolved to ids at start-up, and a missing label stops the start.
- `SENT`, `DRAFT`, `SPAM` and `TRASH` are never received, even if you configure them.
- An email that gets a configured label later (for example, moved from spam back to the inbox) counts as new.

Give the client id and secret to both `app` and `gmail-auth`:

```yaml
# docker-compose.override.yml
services:
  app:
    environment:
      GMAIL_CLIENT_ID_FILE: /run/secrets/gmail_client_id
      GMAIL_CLIENT_SECRET_FILE: /run/secrets/gmail_client_secret
    secrets: [gmail_client_id, gmail_client_secret]
  gmail-auth:
    environment:
      GMAIL_CLIENT_ID_FILE: /run/secrets/gmail_client_id
      GMAIL_CLIENT_SECRET_FILE: /run/secrets/gmail_client_secret
    secrets: [gmail_client_id, gmail_client_secret]
secrets:
  gmail_client_id: { file: ./secrets/gmail_client_id }
  gmail_client_secret: { file: ./secrets/gmail_client_secret }
```

### One consent per mailbox

Run this once for each Gmail mailbox, with the stack's database running:

```sh
docker compose run --rm --service-ports gmail-auth deals
```

1. The command prints an address. Open it in a browser and sign in as the mailbox's own user (`deals@capital.example`).
2. Google asks for one permission only: read your email (`gmail.readonly`).
3. Google redirects to `http://127.0.0.1:8765`. That port is published on the host's `127.0.0.1` only.
4. The command prints `Saved: deals reads deals@capital.example with gmail.readonly.`

The token is refused and not saved if:

- the granted scope is anything other than exactly `gmail.readonly`, or
- the signed-in account is not the configured address.

The refresh token is stored encrypted in the database.

On a server without a browser, forward the port from your own machine first:

```sh
ssh -L 8765:127.0.0.1:8765 admin@inbox-host.capital.example
```

Re-running the command replaces the token. The old token is not revoked, because revoking it at Google would also end
the new authorisation. To remove access completely, revoke the app in the Google account's security settings.

If a token is revoked, only that mailbox stops collecting. The failure is audited and shown at the top of the review
UI.

### Pub/Sub notifications (optional)

Without Pub/Sub, the app polls the mailbox history every `catch_up_minutes`. With Pub/Sub, Gmail's watch notifications
are fetched by **pull**, so no public inbound address is needed:

```yaml
gmail:
  client_id_env: GMAIL_CLIENT_ID
  client_secret_env: GMAIL_CLIENT_SECRET
  pubsub:
    topic: projects/capital-ops/topics/doi-gmail
    subscription: projects/capital-ops/subscriptions/doi-gmail-pull
    service_account_env: GMAIL_PUBSUB_SA
```

- `GMAIL_PUBSUB_SA` (or `GMAIL_PUBSUB_SA_FILE`) holds the JSON key of a separate service account. Give that service
  account permission to pull from this subscription only.
- Gmail itself must be allowed to publish to the topic. Follow Google's Gmail push notification guide for this.
- The watch is renewed daily. A failed renewal is audited and shown at the top of the review UI.
- The catch-up polling keeps running, so a lost notification is still picked up.

Pub/Sub was tested only against a simulated service.

### Before going live: Gmail authentication headers

Gmail writes `Authentication-Results` from `mx.google.com`. So set `trusted_authserv_id: mx.google.com`. Set
`strips_external_auth_results: true` **only after you have checked** that Gmail removes forged headers with the same
authserv-id:

1. From an outside account, send the mailbox an email that carries a forged header, for example
   `Authentication-Results: mx.google.com; dkim=pass header.d=capital.example; spf=pass; dmarc=pass`.
2. Fetch the raw message through the Gmail API (or "Show original").
3. Confirm that the forged header is **gone** and that only Gmail's own header remains. Looking at the top header is
   not enough: Gmail might add its own header above the forged one and keep the forged one.

If the forged header is still there, keep `strips_external_auth_results: false`.

## Microsoft 365

The app uses the client-credentials flow, with a certificate (recommended) or a client secret. Access is limited to
the designated mailboxes through **Exchange RBAC for Applications**, with the role `Application Mail.Read`.

- Do **not** grant any tenant-wide `Mail.*` permission in Entra. Tenant-wide grants add to the Exchange scope and would
  open every mailbox.
- Grant no write or send permission.
- Only delta polling is used. There are no change-notification subscriptions and no inbound address.

### Configuration

```yaml
m365:
  tenant_id: 00000000-0000-0000-0000-000000000000
  client_id: 11111111-1111-1111-1111-111111111111
  certificate_key_env: M365_CERT_KEY        # PEM private key; or client_secret_env instead
  certificate_thumbprint: 0123456789ABCDEF0123456789ABCDEF01234567
  permission_review: { date: 2026-11-01, reviewer: IT Operations }
  negative_probe_mailbox: not-designated@capital.example
mailboxes:
  - id: legal
    name: Legal
    kind: graph
    graph:
      user: legal@capital.example
      folders: [Inbox]
```

- Give exactly one of `certificate_key_env` and `client_secret_env`, through the override file as in the IMAP
  example.
- `folders` are names, and paths such as `Inbox/Deals` are allowed. They are resolved at start-up, and a missing one
  stops the start.
- Each folder has its own cursor. An email moved between two configured folders does not create a second Case.

### The start-up check

The check runs at every start. **Any failure or any uncertain answer stops the start.**

1. **Review record.** `m365.permission_review` must be present and at most **180 days** old. Repeat the review below
   and update the date before it expires.
2. **Entra permissions.** If the app can read its own Entra permissions (only when you have also granted
   `Application.Read.All`), any tenant-wide `Mail.*` application permission on Microsoft Graph refuses the start. If
   the directory answers with a clear "request denied", this step relies on the review record alone.
3. **Positive probe.** Every designated mailbox must be readable.
4. **Negative probe.** `negative_probe_mailbox` must be a real mailbox that the app is **not** allowed to read. It must
   answer "access denied". A readable mailbox, a missing mailbox, a network error or an authentication error all stop
   the start.

The app cannot prove by itself that Exchange gives it no send role. Step 1, the human review, covers that.

### Permission review checklist

Do this before the first start and at least every 180 days. Then record the date and reviewer in
`m365.permission_review`.

- [ ] The app registration has no Microsoft Graph application permissions named `Mail.*` (no `Mail.Read`,
      `Mail.ReadBasic`, `Mail.ReadWrite` or `Mail.Send` granted tenant-wide), and no delegated grants.
- [ ] In Exchange, the app's service principal has exactly one management role assignment: `Application Mail.Read`.
- [ ] That assignment has a custom resource scope that matches only the designated mailboxes.
- [ ] There is no `Application Mail.ReadWrite`, `Application Mail.Send`, `Application Mail Full Access` or other
      application role assignment.
- [ ] Each designated mailbox tests as in scope, and the negative probe mailbox tests as out of scope.
- [ ] Only the certificate or secret configured here exists on the app registration. Expired or unused credentials
      are removed.

### Example PowerShell commands

These are **examples**. Check the cmdlets and parameters against Microsoft's current documentation and try them in
your own tenant before you rely on them. `<app-id>` is the application (client) id.

Exchange Online (module `ExchangeOnlineManagement`):

```powershell
Connect-ExchangeOnline

# the app's service principal in Exchange
Get-ServicePrincipal | Where-Object { $_.AppId -eq '<app-id>' } | Format-List DisplayName, AppId, ObjectId, Identity

# its management role assignments and their scopes
Get-ManagementRoleAssignment -RoleAssignee '<service principal identity>' |
  Format-Table Role, CustomResourceScope, RecipientWriteScope, Enabled

# the scope's filter: it must match only the designated mailboxes
Get-ManagementScope -Identity '<scope name>' | Format-List Name, RecipientFilter

# effective access to one mailbox: designated → in scope; negative probe → not in scope
Test-ServicePrincipalAuthorization -Identity '<app-id>' -Resource 'legal@capital.example'
Test-ServicePrincipalAuthorization -Identity '<app-id>' -Resource 'not-designated@capital.example'
```

Setting up the scope and the role assignment (example):

```powershell
New-ServicePrincipal -AppId '<app-id>' -ObjectId '<enterprise application object id>' -DisplayName 'Trunks — Operations Inbox'
New-ManagementScope -Name 'Deal Ops Inbox mailboxes' -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'legal@capital.example'"
New-ManagementRoleAssignment -App '<app-id>' -Role 'Application Mail.Read' -CustomResourceScope 'Deal Ops Inbox mailboxes'
```

Entra (module `Microsoft.Graph`):

```powershell
Connect-MgGraph -Scopes 'Application.Read.All'

$sp    = Get-MgServicePrincipal -Filter "appId eq '<app-id>'"
$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"

# application permissions granted to the app, by name: there must be no Mail.*
Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id | ForEach-Object {
  $id = $_.AppRoleId
  [pscustomobject]@{ Resource = $_.ResourceDisplayName; Permission = ($graph.AppRoles | Where-Object Id -eq $id).Value }
}

# delegated grants: there should be none
Get-MgServicePrincipalOauth2PermissionGrant -ServicePrincipalId $sp.Id | Format-List Scope, ConsentType

# the app's credentials
Get-MgApplication -Filter "appId eq '<app-id>'" | Select-Object -ExpandProperty KeyCredentials
Get-MgApplication -Filter "appId eq '<app-id>'" | Select-Object -ExpandProperty PasswordCredentials
```
