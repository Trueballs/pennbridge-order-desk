# Local sandbox design

Status: design only. Docker CLI, Compose and running engine were checked on 2026-10-28 (engine 29.6.1). No images pulled or containers launched for this project.

The current [build plan](BUILD-PLAN.md) adds an optional local Odoo integration profile for real quotation-import verification and makes n8n optional for the first release. Its scope and execution sequence take precedence over the earlier fixture-sink-only design below. Implementation remains pending Oscar's “go.”

## Proposed first environment

Use a project-specific Docker Compose stack named `pennbridge-dev`. Services: Next.js application, TypeScript background worker, PostgreSQL, and a Mailpit test mail catcher. Add a dedicated n8n instance only when testing inbox automation. Do not reuse or alter `Automation/n8n` containers, credentials, volumes or workflows.

For this local first slice use plain Postgres and private project-local file storage; this keeps the setup small. Isolate database/storage access behind application adapters. When adding hosted authentication/storage, migrate to Supabase and repeat the permission tests. If immediate Supabase feature parity becomes essential, use its official CLI-managed Docker stack instead of manually rebuilding it in Compose. Do not run two authoritative databases for the same data.

Planned browser bindings: app `127.0.0.1:3087`; Mailpit UI `127.0.0.1:8027`; optional n8n `127.0.0.1:5687`. Check availability before use. Do not publish the database port by default. Use a named volume scoped to this project and fixture-only development credentials. Secrets remain outside Git and outside images. Pin supported image versions/digests when implementing; do not silently follow `latest`.

## Test modes

1. **Offline/mock**: internal Docker network; no external network on runtime services; fake AI adapter; Mailpit captures messages, with outbound SMTP relay disabled. Tests inject `.eml` files into the application's ingestion adapter. Do not assume Mailpit behaves like a production Gmail/IMAP inbox. This mode tests the plumbing and rules, not AI accuracy.
2. **Live AI benchmark**: explicit separate configuration; only synthetic documents; a dedicated API credential and enforced total-run token/cost budgets. The worker needs outbound API access. An ordinary Docker bridge allows broad egress: use a verified restricted proxy/firewall if claiming destination allowlisting. Never describe this mode as offline.
3. **Dedicated test inbox**: later, one empty mailbox owned for this project. Receiving adapters for Gmail/Microsoft require their own OAuth and delivery-semantics tests. Draft customer messages still go to the catcher, not real recipients.

Containers are useful isolation, **not a complete security boundary**. Never mount the Docker socket into the app, use privileged mode, mount the user's home directory, or give test services production credentials. Mount only the project paths needed. Untrusted attachments are size-limited and parsed with timeouts in a restricted worker. Do not fetch arbitrary document links. Do not render attachment HTML as trusted application HTML.

The app and worker share the isolated database network. Production-order export is replaced with a fixture sink. No cloud deployment, real mailbox, supplier system or paid API is required for initial development.

## Lifecycle and checks to implement

- Recreate fixture state deterministically; reset commands must verify the `pennbridge-dev` environment and target only its volumes/data.
- Verify no outbound email escapes; capture a real test message in Mailpit.
- Kill a worker mid-job, restart it and confirm exactly one stored draft/export.
- Verify localhost-only bindings and absence of published database ports.
- Test attempted outbound access in offline mode; absence of credentials alone is not proof of network isolation.
- Restore a backup into a fresh project database and compare data counts/checksums.
- Remember the laptop must be awake to run local services.

References checked 2026-10-28:
- https://docs.docker.com/compose/how-tos/networking/
- https://docs.docker.com/compose/how-tos/use-secrets/
- https://supabase.com/docs/guides/local-development
- https://mailpit.axllent.org/docs/install/docker/
