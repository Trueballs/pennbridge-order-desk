# Existing alternatives and build versus buy

Research checked 28 October 2026. Scope: primary official sources, UK industrial-wholesaler relevance. No vendors contacted, accounts created or pricing quotes obtained.

## What already automates emailed purchase orders?

### Takeaway

This is an established software category, not an unoccupied AI opportunity. Conexiom and Esker already describe most of Pennbridge's proposed extraction, validation, exception-review and ERP-entry workflow; a new build needs a customer-specific reason to exist.

### Cited Findings

- **Conexiom:** its current manufacturing landing page describes email PO intake, checking part numbers/prices/shipping against ERP information, and staff reviewing exceptions. This is vendor-described capability, not independently tested performance. [Conexiom manufacturing](https://info.conexiom.com/manufacturing)
- Its FAQ describes mapping customer PO formats into structured EDI/XML/CSV sales-order output, customer-specific rules for pricing and part numbers, exception notifications, and initial rollouts to five or ten customers. Public numeric pricing was not supplied; the FAQ says subscription customer packs and asks customers to request a quote. The FAQ also contains strong accuracy claims; do not repeat them as established facts. It describes mapped processing and may not represent every current platform mode. [Conexiom FAQ](https://conexiom.com/faq/)
- **Esker:** the current product page advertises intake from email, EDI, portals, ecommerce and punchout; header/line extraction; ERP validation of products, pricing, quantities and delivery details; review routing; ERP posting and document archiving. These are direct overlaps with our spec. No numeric price was present on the reviewed product page. Page-level performance numbers are vendor marketing, not a measured expectation for Pennbridge. [Esker Order Management](https://www.esker.com/solutions/order-management/)
- **NMBS OnePlace:** its straight-through-ordering page says merchants can email or upload PDF/XML POs from their back-office system. Mapped orders are validated, including minimum order value and active product codes, then sent to suppliers. The page requests ten single/multipage PDF examples for mapping. This is a sector-network alternative, rather than evidence that every wholesaler can adopt it unchanged. No numeric pricing for this workflow was shown on that page. [OnePlace order mapping](https://www.oneplace.co.uk/order-mapping/)

### Inferences

- Our proposed differentiator cannot simply be “AI reads emails” or “staff review unclear matches”; established suppliers already advertise these functions.
- A bounded portfolio implementation remains educational. A paid bespoke implementation needs evidence that an existing product or simpler integration does not meet the customer's requirements at an acceptable total cost.
- Repeat structured formats and exact product codes may be handled effectively by mapping/rules; AI should earn its place through evaluated improvement on genuinely variable inputs.

### Gaps

- No comparable quoted all-in costs, deployment times, SME minimums or contract terms were obtained. Do not claim the established solutions are necessarily too expensive or a custom tool will be cheaper.
- Product pages cannot establish whether a specific UK SME already owns such functionality, nor its accuracy on their documents.
- Eligibility, onboarding and supplier coverage for OnePlace would need checking for a real prospect.

## Is there a named industrial customer using this category?

### Takeaway

Yes. Esker's dated Routeco story is direct evidence of order automation at a named UK industrial distributor, but it is a historical vendor case study and should not be treated as current market-wide measurement.

### Cited Findings

- Esker's **14 April 2022** story identifies Routeco as a UK industrial automation/control-products distributor using its Order Management solution. It reports 45% of group-wide orders uploaded hands-free and 30% processed automatically, plus reduced incorrect deliveries and greater operational visibility. Named Routeco executives discuss dashboards and time savings. Later wording on the page broadly calls orders fully automated, which is less precise than the stated percentages; retain the qualified figures if using numbers. [Esker Routeco story](https://www.esker.com/en-gb/blog/customer-stories-order-cash/orders-orders-orders-happy-days/)

### Inferences

- This supports existence and operational relevance of the problem/category in industrial distribution. It does not prove the fictional 18-person Pennbridge company would see the same results or buy Oscar's version.
- The credible project story is an integration/rekeying problem: customers can know their exact products while the supplier still has to convert a document into its own system. Ambiguous descriptions are one exception type, not the essential reason the software exists.

### Gaps

- Routeco source is published by the vendor, not an independent audit; figures are historical. Do not describe them as 2026 performance.
- No willingness-to-pay evidence for our target small business was found, and no employee interview was performed.

## When is a simpler alternative preferable to a bespoke AI tool?

### Takeaway

Start with the order's data format and the systems on each side. If a structured portal/EDI/import route already works, avoid turning clean data into documents and then reconstructing it with AI.

### Cited Findings

- Odoo 17 documentation's search-indexed text describes importing business objects including orders using CSV/XLSX, with a separate row for each order line and External IDs for reliable record references. Direct fetches of the documentation timed out, so this is confirmed from indexed official text rather than a successful live full-page fetch. It establishes a structured-import alternative in that documented version, not PDF/email extraction or a test of the latest Odoo release. [Odoo 17 export/import documentation](https://www.odoo.com/documentation/17.0/applications/essentials/export_import_data.html)
- Esker's current page lists portal/punchout ordering and EDI intake as alternatives within the same order environment, showing that document capture and structured channels can coexist. [Esker Order Management](https://www.esker.com/solutions/order-management/)
- OnePlace specifically offers a route from the merchant's existing back office using PDF or XML, without requiring order details to be re-entered in a new shopping basket. [OnePlace order mapping](https://www.oneplace.co.uk/order-mapping/)

### Inferences

- **Structured web order already integrated into inventory:** connect/repair the integration; no AI extraction is needed.
- **Customer can reliably export compatible CSV/XML:** map and validate the structured data first.
- **Repeated high-volume trading relationship:** assess existing EDI/punchout/network options before custom document processing.
- **Email/PDF orders remain and staff truly rekey them:** compare native ERP features and established document-order products against a narrowly scoped custom adapter.
- Keep our prototype focused on PDF/email → reviewed draft → one explicit import contract. Include a structured-input path that skips AI and compare it to the AI path. That makes the project more commercially honest and technically stronger.
- Before building for a customer, inspect 20–50 permissioned documents and time their complete current workflow. Identify what actually consumes time: entry, customer aliases, prices, amendments, stock, or clarification. A website showing an email ordering address alone does not prove manual rekeying.

### Gaps

- No specific customer's ERP/export/import capabilities, order mix, existing licences, procurement constraints or manual cost are known yet.
- The evidence is sufficient for a realistic learning project and a discovery hypothesis, not a sales forecast or decision to build a general SaaS product.
