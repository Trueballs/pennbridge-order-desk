# Pennbridge project instructions

- Read `docs/BUILD-PLAN.md` and relevant `docs/PROJECT-SPEC.md` sections. Oscar authorized execution on 2026-10-28; do not ask again for routine local build steps.
- Work only in this project. Never modify existing `Automation/n8n` services, unrelated workspaces, personal mailboxes or credentials.
- Inspect Git status and preserve existing changes. One writer per path; coordinate shared contracts, manifests and lockfiles through the parent agent.
- Oscar requests lightweight subagents: use `gpt-6-luna` for bounded fixtures/UI/docs tasks, `gpt-6.1-sol` for core lifecycle/integration and critical review. Maximum three workers plus coordinator. No recursive delegation.
- Each task must state owned paths, interfaces and verification. Return concise changed-files/checks/blockers handoffs. Do not claim model cost savings without measured usage.
- Synthetic data only. Never read expected test outputs from production application code. Mock processing must be labelled as such.
- All approvals/exports are authorized server-side, version-bound and audited. Edits invalidate approval. Retries must not duplicate orders or exports.
- Do not send external mail, connect real accounts, publish, or incur unagreed API/hosting costs. Live-model benchmarking is separately configured; missing keys must not block offline implementation.
- Keep secrets out of source/logs. Use localhost-only browser services, private database networks and project-scoped volumes. Never mount the Docker socket or home directory into app containers.
- Original 50 fixtures remain immutable. Add new PDF and scale fixtures separately; document unsupported formats.
- Update canonical plan/status and README rather than making repeated trackers. Record actual tests and limitations. A CSV export is not a verified Odoo import.
