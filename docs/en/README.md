# Trunks — Operations Inbox: user documentation

Trunks is the Operations Inbox product in Vegeta, software for SPV and syndicate operations teams. It is an open-source, self-hosted, **read-only** email agent for investment-operations inboxes. For each
inbound email it:

- picks a category
- extracts the key facts
- links the email to deals and people in your directory
- flags risk
- prepares a reply from a fixed template for a person to check, copy and send from their own mail client.

It never sends email. It never moves money. It never changes your business records.

| Document | What it covers |
|---|---|
| [Quick start](quickstart.md) | The demo, then a real deployment with Docker Compose |
| [Users and directory](users-and-directory.md) | Creating users and importing deals, commitments, bank lines, ledger and contacts (API with `curl`; no screen yet) |
| [Mailboxes](mailboxes.md) | IMAP, `.eml` import, Gmail, Microsoft 365: permissions and set-up |
| [Models and data protection](models-and-data-protection.md) | Model providers, the start-up checks, what a model sees and what it never does |
| [Configuration reference](configuration.md) | Every key of `deployment.yaml`, `cases.yaml` and `templates.yaml` |
| [Security model](security-model.md) | Read-only guarantees, containers, database roles, audit chain, encryption, fraud rules, known limits |
| [DPIA template](dpia-template.md) | A data protection impact assessment template for the deploying organisation (UK GDPR) |
| [LIA template](lia-template.md) | A legitimate interests assessment template for the deploying organisation (UK GDPR) |
| [Retention](retention.md) | Default retention periods, how deletion works, the hold flag, KYC transfer and replacement |
| [Backup and upgrade](backup-and-upgrade.md) | What to back up, restoring, upgrades, key rotation |

All examples use fictional data and `.example` domains.
