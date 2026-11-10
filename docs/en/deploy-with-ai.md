# Deploy with an AI coding assistant

An AI coding assistant (one that can run commands on your machine) can deploy the Trunks demo from these documents:
a fresh assistant did so in a test, with the prompt below. For a real deployment it can run the commands while a person
does the steps in the table below; that has not been tested with an assistant. A person still decides and approves
everything that concerns access, keys, data and the network, and is responsible for the deployment.

## Two rules

1. **Keys, real email and real directory data never go to the assistant.** A person types secrets, passwords and
   tokens, and the assistant never reads the secret files. The assistant works only with the demo's fictional data.
2. **The assistant stops at access and network steps.** It asks a person before mailbox or OAuth consent, before a
   model provider is chosen or a data processing agreement is recorded, before `sudo`, and before anything is opened
   beyond `127.0.0.1`.

## The demo

Needs: Docker with Compose v2 and about 4 GB of memory for Docker (see [Quick start](quickstart.md#before-you-start)).
The demo uses fictional data, recorded model replies and no outbound connection.

Paste this into the assistant:

```text
Deploy the Trunks demo on this machine.

Documentation: https://vegeta-ops.vercel.app/llms.txt lists the Trunks documents. Follow the Quick start,
section 1 (the demo), and read other documents only when it points to them. The code is at
https://github.com/vegeta-labs/trunks.

Rules:
- Use only the Docker Compose projects and volumes the documents name. Never stop, remove or prune any other
  container, volume, image or network.
- Never read, print or copy the files in demo-secrets/ or secrets/.
- Ask me before any sudo command and before opening any port beyond 127.0.0.1.
- If a step fails, find the cause in the documents and the logs. Do not change the configuration, the code or the
  security settings to get past it; tell me what failed.

When the demo is running, tell me the address and the demo account to sign in with, and stop.
```

When it is done, open <http://127.0.0.1:8080> and sign in with a demo account from the sign-in page. Every `up`
resets the demo; stop it as the [Quick start](quickstart.md#1-the-demo) shows.

## A real deployment

The [Quick start, section 2](quickstart.md#2-a-real-deployment) is the order of work. The assistant can run the
commands; these steps belong to a person:

| Step | Who | Why |
|---|---|---|
| [2.1 Secrets](quickstart.md#21-secrets): run `init-secrets`, keep a copy of the master and HMAC keys | Assistant runs it; **person** keeps the copy | The assistant never opens the files |
| [2.2 Configuration](quickstart.md#22-configuration-directory): `deployment.yaml`, `cases.yaml`, `templates.yaml` | Assistant drafts; **person** checks | |
| Mailbox access and OAuth consent ([Mailboxes](mailboxes.md)) | **Person** | Grants access to real email |
| Model provider and `dpa: true` ([Models and data protection](models-and-data-protection.md)) | **Person** | Decides where investor data goes |
| API keys, mailbox passwords, tokens | **Person** | Rule 1 |
| [2.4 HTTPS](quickstart.md#24-https): DNS, ports 80 and 443 | **Person** approves | Opens the host to the network |
| [2.5 First sign-in](quickstart.md#25-first-sign-in): admin password | **Person** | Rule 1 |
| Users, roles and the directory ([Users and directory](users-and-directory.md)) | **Person** | The commands ask for passwords and keep an admin session; the directory holds real investor data. The assistant may draft CSV columns from the fictional examples |
| DPIA and LIA ([DPIA template](dpia-template.md), [LIA template](lia-template.md)) | **Person** | The deploying organisation's assessment |

For changing the code, the repository's `AGENTS.md` tells the assistant how to build and test, and which rules it must
not change.
