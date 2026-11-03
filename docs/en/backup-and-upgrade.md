# Backup and upgrade

## What to back up

| What | Where | Why |
|---|---|---|
| **Database** | volume `deal-ops-inbox_db` | Cases, directory, users, audit chain, and all text (encrypted) |
| **Files** | volume `deal-ops-inbox_files` | raw emails and attachments (encrypted) |
| **State** | volume `deal-ops-inbox_state` | the daily audit chain head export |
| **Secrets** | your secret directory (`./secrets`) | `doi_master_keys`, `doi_hmac_key` and the database passwords. **Without the keys, a backup cannot be read.** |
| **Configuration** | your configuration directory (`DOI_CONFIG_DIR`) and `docker-compose.override.yml` | to start the same deployment again |
| KYC folder (if you use a folder target) | volume `deal-ops-inbox_kyc` | transferred KYC files; back it up under your KYC policy |

Keep the secrets **apart from** the data backups, with stricter access. Anyone who has both can read everything.

**Keep old master keys.** After a key rotation, backups taken before it still need the old master key. Keep every
master key for as long as you keep any backup made while it was in use.

The audit chain head file (`audit.head_export_path`) should also be copied off the host, separately from the
backups. It lets you detect missing newest audit records after a restore.

## Making a backup

The simplest consistent backup copies the volumes while the stack is stopped:

```sh
# a new directory for every backup: mkdir refuses one that exists, so a second backup never mixes its data with
# the keys and configuration of an earlier one (after a key rotation the keys differ)
B="$PWD/backup/$(date +%Y%m%dT%H%M%S)"
mkdir -p "$PWD/backup" && mkdir "$B" || exit 1
docker compose stop
for v in db files state kyc; do
  docker run --rm -v "deal-ops-inbox_$v:/v:ro" -v "$B:/b" postgres:16 \
    tar --numeric-owner -czf "/b/$v.tgz" -C /v .
done
docker compose start
cp -a secrets "$B/secrets"            # better: store the secrets in a separate, stricter place
cp -a config/local "$B/config"
```

`postgres:16` is used only because it is already present and has `tar`. Any image with `tar` will do.

How long you keep backups is your decision. The app's retention deletion does not reach backups (see
[Retention](retention.md)).

## Restoring into a fresh Compose project

Restore into a new project name, so that the running deployment is never touched.

If you only want to test a backup while the live deployment keeps running, restore with a copy of the configuration
that has **no live mailboxes, no event webhook and no KYC webhook**. For example, change each mailbox to `kind: eml`
with the same `id`, and remove `events.webhook` and a webhook `kyc.target`. Otherwise the restored copy would collect the same
mail and send the same events as the live one. Note that any configuration change makes the restored copy process its
open Cases again, which may call your model provider.

```sh
B="$PWD/backup/20261102T093000"   # the backup to restore
P=doi-restore
export DOI_SECRETS_DIR="$B/secrets" DOI_CONFIG_DIR="$B/config" DOI_PORT=8081
# the restored copy's own file list: never the bundled proxy of the live deployment (it would take the same network
# range and ports 80/443). Keep your override for the credentials if the copy needs them; this overrides .env.
export COMPOSE_FILE=docker-compose.yml

docker compose -p "$P" create          # creates the empty volumes and the containers, starts nothing
for v in db files state kyc; do
  docker run --rm -v "${P}_$v:/v" -v "$B:/b:ro" postgres:16 \
    sh -c "cd /v && tar --numeric-owner -xzf /b/$v.tgz"
done
docker compose -p "$P" up -d
```

Then check:

1. `migrate` exits successfully and `app` starts.
2. The audit chain is intact:

   ```sh
   docker compose -p "$P" exec app node --experimental-strip-types --no-warnings src/main.ts audit verify
   ```

   It prints `ok: <n> records, head <seq> <hash>`, or `BROKEN at seq <n>`.
3. Compare the head with the last line of your off-host copy of the chain head export. The restored head must not be
   older than the backup time.
4. Open a few Cases and their raw emails and attachments.

When you are satisfied, either keep the restored project as your deployment, or remove it with
`docker compose -p doi-restore down -v`.

## Upgrades

1. **Read the release notes** of every version between yours and the new one.
2. **Back up first** (above).
3. Get the new version and build it:

   ```sh
   git fetch --tags
   git checkout <release tag>
   docker compose build
   ```

4. Start it:

   ```sh
   docker compose up -d
   ```

   `migrate` runs first and applies new database migrations. `app` and `maintenance` start only after it has
   succeeded.

Things to know:

- **Migrations only go forward.** There is no down-migration. To go back to an older version, restore the backup you
  made before the upgrade, using the older version's images.
- A configuration change is audited at the next start, and every open Case is processed again.
- A release with new prompts does **not** process Cases that are already done again: the new prompts apply to emails
  processed after the upgrade. Only a change to your own configuration files (including the `model` block) makes
  every open Case be processed again, as above.

## Key rotation

Master keys are listed in the secret file `doi_master_keys` as `id:base64`, separated by commas:

```text
k1:<base64 of 32 bytes>,k2:<base64 of 32 bytes>
```

`app` and `maintenance` write with the **last** key in the list. The rotation tool writes with `DOI_ACTIVE_KEY`.

Steps:

1. **Back up**, including the current `doi_master_keys`.
2. Add a new key **at the end** of the list, on the same line:

   ```sh
   NEW=$(openssl rand -base64 32)
   printf '%s,k2:%s\n' "$(cat secrets/doi_master_keys)" "$NEW" > secrets/doi_master_keys.new
   mv secrets/doi_master_keys.new secrets/doi_master_keys
   chmod 644 secrets/doi_master_keys
   ```

3. **Restart every instance with the new key first:**

   ```sh
   docker compose up -d --force-recreate app maintenance
   ```

   Every running instance must have restarted before the rotation, on every host. Each start records which key it
   writes with. The rotation refuses to start while the services last started with the old key.
4. Run the rotation:

   ```sh
   DOI_ACTIVE_KEY=k2 docker compose run --rm rotate
   ```

   It rewraps the data key of every encrypted text value and every stored file with `k2`, and deletes the old stored
   versions of rewritten files. File contents are not re-encrypted; only the wrapped data key in the file header
   changes. You can stop it and run it again: it continues where it stopped.

   When it finishes, it checks a sample with the new key alone and prints
   `rotation <id> complete: <n> text values and <n> files rewrapped, <n> checked with k2 alone`.
5. Only after the rotation is complete may you remove `k1` from `doi_master_keys` and restart `app` and
   `maintenance`.
   - The app refuses to start if a key that data still needs is missing.
   - An instance that still writes with a key the rotation has moved away from also refuses to start.
6. **Keep `k1`** in your key store for as long as you keep backups made before the rotation.

The HMAC key (`doi_hmac_key`) is not rotated by this tool. Keep it for the life of the deployment.
