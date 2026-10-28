# Pennbridge Order Desk

Portfolio project for Oscar: turn emailed purchase orders into checked, human-approved sales-order drafts for a fictional UK industrial wholesaler.

**Status: pre-build specification and synthetic fixtures. No application or AI evaluation has run. No customer data, live inbox, external sends or paid API calls are used.**

- [Full build and agent execution plan](docs/BUILD-PLAN.md): phases A–G, lighter-model assignments, file ownership, runtime AI choices, post-build testing and finish criteria. **Awaiting Oscar's “go.”**

- [Canonical build plan](docs/PROJECT-SPEC.md): company scenario, business review, architecture, search, cost and readiness gates.
- [Research: email order automation viability](<reports/Email order automation viability.md>): verified supplier examples, existing alternatives and the revised scope.
- [50 readable email scenarios](fixtures/SCENARIOS.md): inputs, expected outcomes and prerequisites.
- [Machine-readable cases](fixtures/cases.json) and `fixtures/emails/`: 50 MIME `.eml` files.
- [Fixture catalogue and accounts](fixtures/context.json): small, exact reference dataset for the 50 cases; **not** the proposed 10,000-SKU scale dataset.
- [Draft system prompt](prompts/order-interpreter.md): versioned extraction and bounded matching rules.
- [Sandbox design](docs/SANDBOX.md): Docker isolation and eventual live API testing.

Regenerate and check the fixtures with Python 3 (standard library only):

```sh
python3 scripts/generate_fixtures.py
python3 scripts/validate_fixtures.py
```

Validation checks fixture integrity, MIME round-tripping, references and expected labels. It does **not** measure model performance or prove production readiness. All 50 cases are visible development/acceptance fixtures; they are not an untouched holdout. Later add independently reviewed, unseen cases and real customer samples with permission.

No Docker services have been launched for this project. Next build milestone: seed data → manual input → review → approved CSV export, before inbox integration.
