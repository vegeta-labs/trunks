# Quick start

This page covers:

1. The local demo. It uses fictional data and no mailbox, model or outbound connection.
2. A real deployment with Docker Compose.

There is no published image yet, so you build the images from this repository first.

## Before you start

| Need | Notes |
|---|---|
| Docker with Compose v2 | Docker Engine on Linux, or Docker Desktop on macOS |
| Memory | Give Docker about **4 GB** of memory. The virus scanner (ClamAV) needs about 1.5–2 GB while it loads its virus database. If Docker has less, ClamAV can be killed while it starts. Measured with the demo's 30 emails processed (2026-11-02, Docker Desktop on macOS): ClamAV 965 MiB, app 156 MiB, maintenance 104 MiB, database 73 MiB, parser 27 MiB; about 1.3 GiB in all. Real mailboxes and larger attachments need more. |
| AppArmor (Ubuntu / Debian hosts only) | The parser container runs under its own AppArmor profile. Load it once (see [AppArmor profile](#apparmor-profile-linux-hosts)). |

Build the images from the repository root:

```sh
docker compose build
```

This builds `trunks:local`, which is used by the `app`, `maintenance`, `migrate` and tool services. It also
builds `trunks-parser:local`, which is used by the `parser` service.

## AppArmor profile (Linux hosts)

On hosts with AppArmor (Ubuntu, Debian), install the parser profile before the first start. Profiles in
`/etc/apparmor.d/` are loaded again at every boot; loading it only from the checkout would last until the next reboot.

```sh
sudo cp deploy/apparmor/trunks-parser /etc/apparmor.d/trunks-parser
sudo apparmor_parser -r -W /etc/apparmor.d/trunks-parser
```

After an upgrade that changes `deploy/apparmor/trunks-parser`, run both commands again.

- The profile needs **AppArmor 4**, for example Ubuntu 24.04, because it uses the `userns` rule.
- If the profile is not loaded, the `parser` container does not start. It is never run unconfined.
- Docker Desktop on macOS has no AppArmor and ignores the option.
- With the profile loaded, Ubuntu 24.04 needs **no** change to `kernel.apparmor_restrict_unprivileged_userns`
  (measured on Ubuntu 24.04: the parser tests pass with the profile in enforce mode and the setting left as it is).

## 1. The demo

```sh
mkdir -m 700 demo-secrets
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/demo-secrets:/out" trunks:local init-secrets /out
TRUNKS_SECRETS_DIR=./demo-secrets docker compose -f docker-compose.yml -f deploy/compose.demo.yml up -d
```

Create the secret directory yourself first. If it does not exist, Docker creates it as root and `init-secrets` fails.

Open <http://127.0.0.1:8080>. The sign-in page lists the three demo accounts:

| User name | Password | Role |
|---|---|---|
| `demo-reviewer` | `demo-reviewer-password` | reviewer |
| `demo-approver` | `demo-approver-password` | approver |
| `demo-admin` | `demo-admin-password` | admin |

What the demo does:

- It runs as its own Compose project (`trunks-demo`) with its own volumes. It never touches the volumes of a
  real deployment.
- It loads a fictional directory: three deals with their investors and contacts.
- It receives about 30 fictional emails from built-in `.eml` files.
- It uses recorded model replies ("replay"), so no model is called.
- ClamAV uses the virus database that comes with its image and does not download updates. The demo makes no outbound
  connection.
- It listens on `127.0.0.1` only. In demo mode the session cookie does not carry `Secure`, so that Safari can sign in
  over `http://`.
- KYC attachments are transferred to a folder on the demo volume. In the demo the stored email is **not** replaced
  afterwards (a real deployment replaces it; see [Retention](retention.md)).
- **Every `up` resets the demo database.** Changes you make in the demo do not survive.
- The emails keep their original receive times, so some deadlines show as overdue. Some demo emails are dated a few
  days after today's date in the fictional data; the example dates are fictional and may be later than today.
- **A successful verification approval takes two days in the demo.** The demo accounts are created again at every
  `up`, and an approval needs accounts and roles older than one cooling-off period (24 hours) when the checklist is
  done, and then the task's own 24 hours. A checklist ticked within a day of `up` can therefore never be approved;
  you see the refusal instead. Use **Restart verification** with a reason to replace that checklist, then complete it after the accounts are old enough. To see an approval, leave the demo running without another `up`, tick a checklist more
  than 24 hours after the start, and approve as `demo-approver` 24 hours later. See
  [Users and two-person control](users-and-directory.md#users-and-two-person-control).

The demo refuses to start if its configuration has a mailbox other than `.eml`, a model other than replay, an event
webhook, a KYC webhook or OIDC sign-in. A demo database can never become a real deployment, and a real database is
never reset by the demo.

Stop it with:

```sh
TRUNKS_SECRETS_DIR=./demo-secrets docker compose -f docker-compose.yml -f deploy/compose.demo.yml down
```

## 2. A real deployment

### 2.1 Secrets

```sh
mkdir -m 700 secrets
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/secrets:/out" trunks:local init-secrets /out
```

`init-secrets` writes random passwords and keys, one file each:

| File | Used by |
|---|---|
| `postgres_password`, `owner_database_url` | the database and `migrate` |
| `trunks_app_db_password`, `trunks_maintenance_db_password`, `trunks_rotation_db_password` | `migrate`, which sets the three role passwords |
| `app_database_url` | `app`, `gmail-auth` |
| `maintenance_database_url` | `maintenance` |
| `rotation_database_url` | `rotate` |
| `trunks_master_keys` | the encryption master keys (`k1:<base64>`) |
| `trunks_hmac_key` | the deployment HMAC key |
| `initial_admin_password` | the first admin's password |
| `anthropic_api_key` | empty; fill it in if you use the hosted model provider |

- The directory is mode 700 and the files are 0644 inside it. Containers that run as other users can read them, and
  other users on the host cannot.
- Running `init-secrets` again only adds missing files. It never overwrites a file.
- Compose reads the secrets from `./secrets`. Set `TRUNKS_SECRETS_DIR` to use another directory.
- **Keep a copy of `trunks_master_keys` and `trunks_hmac_key` somewhere safe.** Without them the stored data cannot be
  read. See [Backup and upgrade](backup-and-upgrade.md).

### 2.2 Configuration directory

Copy the default configuration and point Compose at the copy:

```sh
cp -r config/default config/local
echo 'TRUNKS_CONFIG_DIR=./config/local' >> .env
```

Edit the three files: `deployment.yaml`, `cases.yaml` and `templates.yaml`.

- The configuration is checked at every start. An invalid file stops the start, and the error names the file and the
  line.
- Secrets never go into these files, only the **names** of environment variables.
- Every key is described in the [Configuration reference](configuration.md).

You must decide at least these:

- `deployment.name`, `deployment.timezone` and `deployment.currencies`.
- `mailboxes`: see [Mailboxes](mailboxes.md).
- `model`: the default file names the hosted provider with `dpa: false`, so **the app refuses to start** until you
  record a data processing agreement (`dpa: true`) or choose a local model. See
  [Models and data protection](models-and-data-protection.md).
- `kyc.target`: where possible-KYC attachments go. Without one, every transfer fails and is reminded daily. The
  default `deployment.yaml` has a commented example.

Mailbox, webhook and OIDC credentials are read from environment variables, or from a file named by
`<NAME>_FILE`. The base `docker-compose.yml` mounts only the secrets listed above. Add your own through a
`docker-compose.override.yml`; [Mailboxes](mailboxes.md) has an example.

### 2.3 Start

```sh
docker compose up -d
```

The services start in this order:

1. `db` (Postgres 16) and `clamav`.
2. `migrate`, which creates the tables and the three database roles and then exits.
3. `app` and `maintenance`, which start only after `migrate` has finished successfully.

ClamAV can take several minutes on the first start while it loads its database.

The app listens on `127.0.0.1:8080` on the host. Set `TRUNKS_PORT` to change the port.

### 2.4 HTTPS

The session cookie always carries `Secure`, so use HTTPS. You have two options.

**Option A: the bundled proxy.** The override file `deploy/compose.proxy.yml` adds Caddy in front of the app. Caddy obtains a
certificate for your domain automatically. Your domain's DNS must point at the host, and ports 80 and 443 must be
reachable.

```sh
echo 'TRUNKS_DOMAIN=inbox.capital.example' >> .env
echo 'TRUST_PROXY=172.30.99.10' >> .env
# every compose file of this deployment, kept in .env so that every later command uses all of them;
# leave out docker-compose.override.yml if you have none
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:deploy/compose.proxy.yml' >> .env
docker compose up -d
```

**Keep the full file list in `COMPOSE_FILE`.** Naming files with `-f` on the command line makes Compose skip
`docker-compose.override.yml`, so a command such as `docker compose -f docker-compose.yml -f deploy/compose.proxy.yml up -d`
would recreate the app **without** the mailbox credentials of your override file, and the app would not start. With
`COMPOSE_FILE` in `.env`, plain `docker compose …` commands (up, stop, run, backup, upgrade) always use the same set.

The proxy has a fixed address, `172.30.99.10`, on a fixed network `172.30.99.0/24` (only this override file takes that range, so the demo or a restored copy can run next to it), and `TRUST_PROXY` must name that
address (the app trusts addresses, not service names). If that range is already used on your host, set
`TRUNKS_EDGE_SUBNET` and `TRUNKS_PROXY_IP` to another range and address, and `TRUST_PROXY` to the same address. Caddy fetches
its certificate from Let's Encrypt: an outbound connection that carries no email content.

**Option B: your own reverse proxy.** Leave `deploy/compose.proxy.yml` out and forward HTTPS to `127.0.0.1:8080`.

`TRUST_PROXY` controls which forwarding headers the app trusts. It is unset by default, so no forwarding headers are
trusted. If you need the client address from your proxy, set `TRUST_PROXY` to the proxy's IP address or CIDR range (a
comma-separated list is allowed). Never trust every address.

### 2.5 First sign-in

1. Sign in as `admin` with the password from `secrets/initial_admin_password`. Before HTTPS is set up, sign in at
   `http://127.0.0.1:8080` with Chrome, which accepts the `Secure` cookie on `127.0.0.1` (measured). Safari does not
   (measured), so use it only over HTTPS. Other browsers were not measured.
2. You must change the password before you can do anything else.
3. Then remove the initial password from the host:

   ```sh
   : > secrets/initial_admin_password
   ```

   The file is read only while the database has no users. Keep the empty file, because Compose still mounts it.
4. Create the other users (reviewer, approver, admin), or set up OIDC sign-in (`auth.oidc`). This version has no
   screen for this: use the `curl` commands in [Users and directory](users-and-directory.md). Read its section on
   two-person control first: on a new deployment the first verification task can be approved only after about
   48 hours.

### 2.6 What to do next

- Connect a mailbox: [Mailboxes](mailboxes.md).
- Import your directory (deals, commitments, bank lines, ledger, contacts) as an admin, with the `curl` commands in
  [Users and directory](users-and-directory.md). Until you do, no email is linked to a deal or a contact, and replies
  never show record data.
- Read the [Security model](security-model.md) and fill in the [DPIA](dpia-template.md) and [LIA](lia-template.md)
  templates.
- Plan backups: [Backup and upgrade](backup-and-upgrade.md).
- Know what to do when a Case fails: [2.7](#27-cases-that-fail).

### 2.7 Cases that fail

Each email goes through a fixed series of steps (receive, virus scan, attachment parsing, rules, redaction, model
classification and fields, linking, risk, reply, routing, events). A step that fails is retried three times within
about a minute. If it still fails, the Case shows the status `failed` and the step where it stopped, for example
`classify`. A failure deletes nothing: the stored email stays as it was (for an email whose KYC attachments were
already transferred, that is the copy without them; see [Retention](retention.md)).

Common causes:

| Step | Usual cause |
|---|---|
| `scan` | ClamAV is not running, or is still loading its database (only emails with attachments are scanned) |
| `parse` | the `parser` container is not running (on Linux: its AppArmor profile is not loaded) |
| `classify`, `fields` | the model provider rejects the API key, or cannot be reached at all (connection refused, unknown host) |

Find the cause from the step and the table: for `scan` and `parse`, `docker compose ps` and
`docker compose logs clamav` or `docker compose logs parser` show it; for `classify` and `fields`, check the model
settings and the API key, and that the app can reach the provider. Every failed attempt writes a log line with a
fixed reason code. The Case and API show its fixed sentence; the exception text stays in encrypted audit detail.

| Code | Meaning |
|---|---|
| `model_setup` | Check the model configuration, credentials and connection. |
| `replay_missing` | A required replay recording is missing. |
| `parser_unavailable` | The attachment parser could not be used. |
| `scanner_unavailable` | The virus scanner could not be used. |
| `storage_error` | The file store could not be used. |
| `database_error` | A database operation failed. |
| `internal` | An unexpected internal error occurred. |

The job queue stores the fixed code too. A successful restart or KYC continuation clears the previous failure code.
PostgreSQL's own server logs may contain constraint-error details; manage those under the database log policy. **If the fix changed a
secret or the configuration** (for example a new model API key in `secrets/anthropic_api_key`), recreate the app
first, because it reads them only when it starts:

```sh
docker compose up -d --no-deps --force-recreate app
```

Then run the failed Cases again from the step where they stopped:

```sh
docker compose run --rm app rerun-failed
```

Without arguments it runs every failed Case again; you can also name Case ids
(`docker compose run --rm app rerun-failed <case id> …`; the id is in the Case's address, `#case=<id>`). The steps
before the failed one are not repeated; a Case that failed after its reply was drafted gets a new draft. Each re-run is recorded in the audit chain (`case.rerun_failed`, with the actor `system`: the command does not know who ran it). A Case that
fails again shows `failed` again.

A model provider that answers with an error (for example "overloaded"), or does not answer in time, does **not**
make the Case fail. The model is tried twice, then the Case goes on without that model answer and is routed as usual:

- if the classification failed, the Case keeps the classes the rules found (for example `bank_details`); only when
  the rules found none either is it `unclassified`;
- if a field extraction request failed, the classes stay, and the fields that request asked for come from the rules
  only; fields from the model's other requests for the same email (some classes need two) are kept.

`rerun-failed` does not touch such Cases, and the model is not asked again for them. A person checks the classes and
fields on the Case page and corrects them by hand; the later steps then run again.

## Compose variables

Put these in a `.env` file next to `docker-compose.yml`, or set them in the shell.

| Variable | Default | Meaning |
|---|---|---|
| `TRUNKS_CONFIG_DIR` | `./config/default` | The configuration directory, mounted read-only at `/config` |
| `TRUNKS_SECRETS_DIR` | `./secrets` | The secret directory |
| `TRUNKS_PORT` | `8080` | The host port on `127.0.0.1` |
| `TRUNKS_VERSION` | `local` | The image tag |
| `TRUNKS_DOMAIN` | `localhost` | The domain for the bundled proxy |
| `TRUST_PROXY` | unset | The proxy addresses whose forwarding headers the app trusts |
| `TRUNKS_ACTIVE_KEY` | unset | Only for key rotation (see [Backup and upgrade](backup-and-upgrade.md)) |
| `TRUNKS_EDGE_SUBNET` | `172.30.99.0/24` | The network of the app and the bundled proxy |
| `TRUNKS_PROXY_IP` | `172.30.99.10` | The bundled proxy's fixed address (what `TRUST_PROXY` names) |
| `DEMO` | unset | Set by `deploy/compose.demo.yml`; never set it for a real deployment |
