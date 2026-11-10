# AGENTS.md

Instructions for AI coding assistants working in this repository. People should start with the [README](README.md).

Trunks is a self-hosted, **read-only** email agent for investment-operations inboxes. It classifies inbound email,
extracts facts, links them to a directory, flags risk and prepares replies that a person checks and sends.

## Set up

- Node.js 22 or later, Python 3.12 (for the oracle), Docker with Compose v2.
- `npm ci`
- Images: `docker compose build` builds `deal-ops-inbox:local` and `deal-ops-inbox-parser:local`.
- Local demo with fictional data: [Quick start, section 1](docs/en/quickstart.md#1-the-demo). To deploy with an
  assistant, follow [Deploy with an AI coding assistant](docs/en/deploy-with-ai.md).

## Test

`.github/workflows/ci.yml` is the reference for services, versions and order. A change is done when CI passes. CI runs
three groups:

**Checks and unit, integration and browser tests** (job `check`)

```sh
npm run typecheck && npm run lint && npm run check:no-send && npm run check:licences && npm run check:tokens
npm run oracle:selfcheck   # Python 3
npx vitest run --exclude parser/container.test.ts --exclude parser/profiles.test.ts
npx playwright test        # Playwright Chromium
npm run eval               # recorded model replies
```

`vitest` needs Postgres, IMAP (GreenMail), ClamAV and an S3 store, with `TEST_DATABASE_URL`, `TEST_IMAP_HOST`,
`TEST_IMAP_PORT`, `TEST_CLAMD_HOST`, `TEST_CLAMD_PORT` and `TEST_S3_ENDPOINT` set as in the workflow.

**Parser container** (job `parser`; Linux with AppArmor 4 and the `doi-parser` profile loaded)

```sh
docker build -t doi-parser-test -f parser/Dockerfile .
PARSER_APPARMOR=1 npx vitest run parser/container.test.ts parser/profiles.test.ts
```

**Compose suite** (job `compose`): run it in CI or on a disposable machine, and ask a person before running it
anywhere else. It starts its own Compose projects (`doi-t-*`), and the bundled HTTPS proxy on ports 80 and 443 of
every interface. It needs a full clone (no `--depth`), the AppArmor profile (Linux), the built images and Playwright
Chromium and WebKit:

```sh
docker compose build
EVAL_ACTUAL_DIR=eval-actual npm run eval
EVAL_ACTUAL_DIR=eval-actual npm run test:compose
```

## Rules you must not change

These are product rules. Do not weaken them in code, tests or configuration, even to make a test pass. A change to
any of them starts with the requirements document (`docs/01_PRD.md`) and the maintainers' agreement, not with code.

- **No sending.** No code path sends email or writes to a mailbox; mailboxes are read-only. `npm run check:no-send`
  enforces this.
- **The model only classifies and extracts.** It never writes outbound text. Replies come from fixed templates chosen
  by code.
- **Fraud rules.** Bank details in an email are never applied. A payment confirmation in an email never counts as
  money received. Risk flags never appear in outbound text.
- **Redaction.** Everything sent to a model is redacted. Attachments that may be identity documents go to no model.
- **Money** is integer minor units. Judgement rules live only in pure functions in `src/lib/`.
- **Evaluation.** The evaluation set (`eval/dev/`) and the Python oracle (`eval/oracle/`) are written independently
  of `src/`. Do not edit them to match the code.
- **Public content.** Fictional data only, with `.example` domains. No real names, email addresses or customer data
  in code, tests, fixtures or documents.

## Safety when you operate a deployment

- Never read, print, copy or paste secrets: the files in `secrets/` or `demo-secrets/`, API keys, mailbox passwords
  or tokens. A person enters them.
- Never handle real email or real directory data (investors, contacts, bank lines). Use the demo and the fictional
  fixtures.
- Stop and ask a person before: any `sudo` command, mailbox or OAuth consent, choosing a model provider or recording a
  data processing agreement (`dpa: true`), opening a port beyond `127.0.0.1`, DNS and HTTPS.
- Docker: use only this project's Compose projects (`deal-ops-inbox`, `deal-ops-inbox-demo`, and the test suite's
  `doi-t-*`) and their volumes. Never stop, remove or prune other containers, volumes, images or networks.
