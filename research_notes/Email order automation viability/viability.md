# Commercial credibility and project scope

Research checked 2026-10-28. This is a desk-research assessment, not customer discovery. No companies were contacted. Read the local PROJECT-SPEC.md version 0.2 as design context; no project files were changed by this researcher other than these notes.

## Does website ordering eliminate the problem?

### Takeaway

The user's objection is correct for orders that already enter a supplier's order system through a working structured checkout or integration. It does not eliminate the separate email/PDF channel. Public supplier pages show coexistence, and an industry service explicitly documents purchase orders sent from buyers' back-office systems.

### Cited Findings

- Production Automation, a UK controls/automation supplier, offers website purchases and separately permits trade-account purchase orders by email within the customer's credit limit. This is direct first-party evidence that a supplier can have checkout and still accept email POs. The page is live but undated; it says nothing about channel volumes or whether entry is manual. [Production Automation ordering information](https://www.production-automation.co.uk/pages/contact-us)
- Mistral Industrial Chemicals tells UK and Irish businesses to select products on its website, prepare a purchase order with product names, sizes and quantities, and email it. It says it verifies the order and returns a pro-forma invoice. This directly illustrates a customer knowing what to buy while still submitting a document. It does not establish the internal data-entry mechanism or labour required. [Mistral purchase-order instructions](https://mistralni.co.uk/pages/purchase-orders)
- NMBS OnePlace describes emailing/uploading PDF or XML purchase orders from a merchant's back-office system. It checks conditions including active product codes and minimum order value and sends qualifying orders to the supplier. Its service is intended to avoid entering the order again; PDF layouts are mapped during onboarding. This is concrete evidence of an existing document-to-transaction workflow, and also of an existing alternative. [OnePlace Straight Through Ordering](https://www.oneplace.co.uk/order-mapping/)
- A Conexiom-published ADI Global Distribution case study describes previously rekeying emailed POs into SAP/Adonis and selecting automation partly to preserve existing customer behaviour. The case begins with a 2019 problem and describes subsequent deployment; it is not a 2026 UK-SME survey. Vendor claims and named customer statements support existence of the workflow, not average savings or present demand at small firms. [Conexiom ADI case study](https://conexiom.com/case-studies/adi-global-distribution-helps-improve-sales-effectiveness-with-conexiom)

### Inferences

- The best explanation is: **the customer may know the exact part; the supplier may still need to transfer that information from the customer's PDF into its own order system.** These are different tasks.
- A website's existence is a poor qualification test. Ask whether emailed orders remain and what actually happens after receipt. A supplier accepting email is not automatically a prospect: it may already automate the channel.
- Buyer procurement systems, established trade-account processes and avoiding duplicate entry can explain email's persistence in the documented examples. Do not assert that these reasons apply to every supplier or that customers universally refuse portals.
- Integrated checkout, EDI, XML or a purchasing portal can be better than converting data into a document and extracting it again. Use already structured data directly when available.

### Gaps

- No verified proportion of UK industrial-wholesale orders arriving by email was established.
- No verified data-entry workload, channel mix, current software or budget was found for the small suppliers above.
- No evidence establishes Pennbridge's invented 1,200 monthly email orders, eight-minute baseline or 160 hours/month as typical. They must remain labelled scenario assumptions.

## Is this commercially credible, and what should change in the build?

### Takeaway

**MODIFY/GO as a portfolio project; commercial demand remains unvalidated.** Build a narrow, reviewable email/PDF-to-sales-order workflow. Position fuzzy product interpretation as exception handling rather than the reason every order needs AI.

### Cited Findings

- Esker's official UK product page describes header/line extraction, validation against ERP products/prices/quantities/delivery details, exception handling and ERP posting. It accepts orders from email, EDI, ecommerce and other channels. This means the broad proposed functionality is already a marketed product category; building it does not establish novelty. Performance percentages on the page are vendor marketing claims and should not become targets or promises for this project. [Esker Order Management](https://www.esker.com/en-gb/solutions/order-management/)
- OnePlace already accepts PDF/XML orders, validates active product codes and maps PDF layouts. Its workflow shows that a specific integration/mapping service can solve the practical problem without relying on a general autonomous catalogue-search agent. [OnePlace](https://www.oneplace.co.uk/order-mapping/)
- ADI's vendor-published case describes the problem as transferring emailed documents into existing ERP systems and retaining customers' current ordering behaviour. That supports a transfer/integration framing more directly than a story about customers not knowing their products. [Conexiom ADI case study](https://conexiom.com/case-studies/adi-global-distribution-helps-improve-sales-effectiveness-with-conexiom)

### Inferences

Recommended changes to PROJECT-SPEC.md (proposals, not edits):

1. **Rewrite the primary value proposition:** "Reduce rekeying of emailed purchase orders into the supplier's sales-order system, while preserving checks and approval." Do not lead with AI finding a part from a vague description.
2. **Choose one repeat-order niche and one destination integration.** A small industrial distributor remains a plausible fictional setting. For commercial work it is a hypothesis, not a proven underserved segment. Select a real import schema or test ERP instance before claiming end-to-end usefulness. A generic CSV download proves only an intermediate step.
3. **Make machine-generated PDFs an early milestone.** The current 50 fixtures contain actual MIME emails but only text/HTML attachments. PDF support is currently milestone five, despite PDFs being central to the documented workflow. Add a few genuine synthetic PDF layouts before building a sophisticated matcher. Scans/OCR can be a second supported-format tier.
4. **Build the exact-code path first:** extract PO/account/addresses/lines → exact SKU or maintained customer alias → validate quantities/units/prices → review → import. The customer can have selected the right product and still benefit from this process.
5. **Keep catalogue search bounded but secondary.** Candidate search is useful for missing/internal codes and descriptions. It should not be invoked for every exact SKU, and a maintained alias table may beat an LLM for repetitive accounts.
6. **Separate the 50-case acceptance suite from a representative workload.** Existing labels have 14 draft-ready cases and 30 needs-review cases, plus lifecycle cases. Those are useful edge cases; they cannot tell us the real workload's exception rate or ROI. Do not pretend the artificial mix is typical. Later use anonymised, consecutive real samples for workflow evaluation, plus a separate stress suite.
7. **Retain 10,000 SKUs as an engineering scale test, not a demand claim.** Scale can demonstrate indexed retrieval and near-match handling, but it should not delay the first end-to-end path. Validate the family/variant model and include realistic neighbouring products; 10,000 random names are not a realistic catalogue.
8. **Preserve one source of truth.** Product, unit, customer and price data should be imported/read from the supplier's existing system. A second independently maintained catalogue creates another operational burden.
9. **Measure net work removed.** Include upload/inbox triage, review, corrections, manual exceptions and failed exports—not just model response time. Human review may erase savings if it requires rereading every field.
10. **Demonstrate buy-versus-build judgment.** A credible CV story can explain why a native import, existing vendor, portal or EDI connection would be preferable in some cases. Commercial value may be configuration/integration rather than selling a new platform.

Suggested showcase narrative (clearly fictional): A customer selects known products, produces a PO in its purchasing software and emails the PDF. The supplier's administrator currently transfers the lines to the order system. The demo creates the draft, checks identifiers/units/prices, flags one mismatch, and produces a verified import. This directly addresses the user's website objection.

### Gaps

- No evidence here proves small firms cannot afford or use existing products. Do not make "enterprise tools are too expensive for SMEs" the differentiation without actual quotations and requirements.
- No customer interview, sample of real orders, measured baseline or paid commitment exists.
- No independent comparative test establishes that an LLM is more reliable or economical than PDF mapping/templates for the selected inputs.
- A portfolio can be worthwhile without a new market opportunity. Employer response and likelihood of hiring cannot be inferred from the public sources.

## What discovery and go or no-go evidence is needed?

### Takeaway

Proceed with a bounded learning prototype if Oscar wants to learn these skills. Before a broader commercial build, obtain first-hand evidence of manual work, integration feasibility and a named user willing to test it. The following gates are proposed project decisions, not sourced industry norms.

### Cited Findings

- OnePlace requests ten single-/multi-page PDF examples to map a merchant's orders. That illustrates why document samples and actual layout variation matter before implementation; ten is its onboarding request, not a general statistical sufficiency rule. [OnePlace onboarding instructions](https://www.oneplace.co.uk/order-mapping/)
- Esker describes validating against ERP data and then posting into the ERP, supporting the need to investigate the destination rather than stopping at extraction accuracy. [Esker workflow](https://www.esker.com/en-gb/solutions/order-management/)

### Inferences

Proposed discovery questions for an operations/order-desk employee:

- Show the last emailed order from arrival to a recorded sales order. What did you type, check, ask and correct?
- Over a normal recent period, how many orders arrived through email, checkout and integrations? How many email orders were already entered automatically?
- Do emailed POs usually contain your SKU, the customer's code, a manufacturer reference or just descriptions?
- Which fields generate follow-up? What are the costly errors?
- Why do these customers use email? Would an existing portal, structured export or EDI connection be acceptable?
- What software receives the final order? Can it import sales orders and lines, maintain external references, reject duplicates and expose product/price data?
- What automation is already licensed or available from the current software vendor? Has it been tried?
- Can an authorised employee supply anonymised examples and verify the expected results? Who owns the process and would review a shadow-mode trial?

Proposed commercial go/no-go gates:

1. Speak to at least three relevant businesses to avoid basing the idea on one convenient anecdote; no outreach is authorised or performed in this research task.
2. At least one has a named process owner, permissioned samples and demonstrable recurring manual rekeying not already solved by its present tools.
3. Prove a draft round-trip into a test destination using real field requirements. Reject an integration that needs brittle unrestricted desktop automation for the first project.
4. Time manual and assisted work on the same representative mix, including correction and exception time. Retain the spec's proposed 50% median handling-time improvement as a test hypothesis; also report total time and tail cases. Do not treat a synthetic demo as evidence of labour savings in a real business.
5. Require no silent critical SKU/unit/quantity errors in the pilot sample, explicit review on uncertainty and no unapproved production writes. A zero-error small sample does not imply a zero population error rate.
6. Calculate value using measured eligible monthly volume and net minutes saved, then subtract hosting/API/support and remaining operating costs. Compare with incumbent automation, native imports and process changes. A business-specific acceptable payback threshold must come from its decision-maker, not an invented market price.
7. Obtain a real commitment to a bounded pilot before framing the project as a product companies will buy. The commitment could be named staff time, sample access and a scheduled evaluation; willingness to pay still needs a separate conversation.

**Stop or pivot** if email volume is negligible, data already flows automatically, manual checking dominates and cannot be reduced, master data is unusable, no feasible import exists, or an existing tool solves it with lower overall effort/cost. If those gates fail, retain it as an explicitly educational portfolio project or change to a problem observed in customer discovery.

### Gaps

- These business-specific gates cannot be completed from public webpages. Research establishes that the workflow and existing solutions are real; discovery must establish whether there is a suitable accessible customer.
- No market-wide viability verdict is possible from a handful of supplier pages and vendor case studies.
