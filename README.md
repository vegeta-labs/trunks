# Trunks — Operations Inbox

Trunks is part of Vegeta, software for SPV and syndicate operations teams. It is an open-source, self-hosted, **read-only** email agent for investment-operations inboxes. For each inbound email it:

- classifies it and extracts the key facts (amounts, references, dates);
- links it to the deal, the investor and the contact in your directory;
- flags risk (changed bank details, look-alike senders, payment "evidence", pressure, prompt injection);
- prepares a reply from a fixed template for a person to review, copy and send;
- routes it to a queue with a due time.

**A person reviews everything. The agent never sends email, never writes to a mailbox, never moves money and never changes business records.** Emailed bank details are never applied, and an emailed payment confirmation never counts as received.

**Website:** https://vegeta-ops.vercel.app/inbox/

## Try it

[Open the online read-only demo](https://vegeta-ops.vercel.app/inbox/demo/) to explore a fictional, pre-recorded snapshot. It has no live mailbox or model connection and cannot change records.

### Full local demo

The local deployment includes the server and review workflow. The demo runs on your machine with fictional data, recorded model replies and no outbound connections:

```sh
docker compose build
# Ubuntu / Debian hosts only (skip this line on macOS): install the parser's AppArmor profile, loaded again at every boot
sudo cp deploy/apparmor/trunks-parser /etc/apparmor.d/ && sudo apparmor_parser -r -W /etc/apparmor.d/trunks-parser
mkdir -m 700 demo-secrets && docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/demo-secrets:/out" trunks:local init-secrets /out
TRUNKS_SECRETS_DIR=./demo-secrets docker compose -f docker-compose.yml -f deploy/compose.demo.yml up -d
```

Then open <http://127.0.0.1:8080>. The sign-in page lists the demo accounts.

## Documentation

English user documentation is in [`docs/en/`](docs/en/README.md): quick start, users and directory, mailboxes (IMAP, Gmail, Microsoft 365, `.eml`), models and data protection, configuration reference, security model, DPIA and LIA templates, retention, backup and upgrade.

The design documents (requirements, technical design, rules and review process, test plan) are in Chinese in [`docs/`](docs/). Code comments refer to their rule numbers (`R-…`, `C-…`). How each stage was reviewed is in the [review summary](docs/en/REVIEW_SUMMARY.md).

## What has been tested

- Unit, integration and browser tests, an independent Python oracle for the rules, mutation checks, and an evaluation set of fictional emails written by independent agents (run on recorded model replies in CI).
- The Docker Compose packaging, the demo, backup, restore and upgrade, on Linux (Ubuntu 24.04, with the parser's AppArmor profile) and Docker Desktop on macOS.
- Gmail: read-only collection on one personal Gmail account. Microsoft 365 and Gmail Pub/Sub: only against simulated services.

## Licence

Apache-2.0. Part of Vegeta ([GitHub](https://github.com/vegeta-labs)). Not affiliated with any platform.
