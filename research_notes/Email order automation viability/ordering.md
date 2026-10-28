# Actual supplier order intake

Research checked 28 October 2026. Scope: primary supplier evidence, predominantly UK. All supplier ordering pages below are undated live pages accessed during this research, not time-series data or verified transaction records. No supplier was contacted. Sources establish advertised channels; they do not establish order volumes, internal manual work, software gaps or willingness to pay.

## Do suppliers accept emailed purchase orders despite having checkout?

### Takeaway

Yes. Five UK supplier sites explicitly publish email-PO ordering alongside online catalogue/checkout facilities. This supports the existence of the proposed intake channel, but should not be presented as a market-size estimate or proof that these firms need a new tool.

### Cited Findings

- **Production Automation**, a controls/automation supplier, lists 24-hour website purchases and separately permits trade-account customers to email POs up to their agreed credit limit, on 30-day net terms. It also offers pro-forma invoicing outside website processing. This is the closest clear industrial-components example. The `www` page opened successfully; the no-www URL initially failed. [Production Automation buying methods](https://www.production-automation.co.uk/pages/contact-us)
- **Mistral Industrial Chemicals** tells UK/Irish company buyers to select products on its website, prepare their own headed-paper PO with names, sizes and quantities, and email it. Mistral then verifies the order and issues a pro-forma invoice including delivery. This is especially useful evidence that knowing the exact product and sending a document can coexist. Its page includes a shopping cart. [Mistral purchase orders](https://mistralni.co.uk/pages/purchase-orders)
- **Workplace Gloves** presents three alternatives: web checkout with a PO reference, emailing product names/codes, quantities and sizes, or uploading a PO document. Accepted upload types include PDF, DOC, DOCX, PNG and JPG. Its stated audience includes industrial/safety companies as well as other businesses. [Workplace Gloves purchase orders](https://workplacegloves.co.uk/purchase-orders-b2b/)
- **Gloves N Stuff** offers card checkout with a PO-number field and separately accepts emailed official POs in JPG, PDF, Word or other common formats. Its page requests product titles, quantities and billing/delivery addresses and addresses public-sector customers. [Gloves N Stuff purchase orders](https://www.glovesnstuff.com/pages/purchase-orders)
- **Battery Group** has an online product catalogue/cart and explicitly accepts emailed official public-sector POs. The PO must identify the authorised organisation and products, with prices matching the website and delivery charge included. This is a narrower public-sector example, not a statement that all its customers use email. [Battery Group purchase orders](https://batterygroup.co.uk/purchase-orders)

### Inferences

- The user's objection is valid for clean website orders but does not eliminate a separate emailed-document channel. A suitable scenario is a supplier with both a web shop and account buyers who submit their own POs.
- Production Automation's trade-credit route and the public-sector suppliers' official-PO routes suggest purchasing/account processes can influence channel choice. These pages do not prove which motivation dominates for individual buyers.
- PPE, chemicals and components are different product markets. The evidence supports a broad B2B supplier workflow; it is not proof that every manufacturer or parts wholesaler works this way.

### Gaps

- No email share, monthly volume, manual-entry time, current ERP, existing extraction automation or buying intent was disclosed on these pages.
- Do not label these businesses as qualified sales prospects merely because they accept emailed orders.
- J. P. Lennard's search result described website/email ordering, but direct opens failed; exclude it from the verified five rather than rely on the snippet.

## Can the customer know exactly what they want while the supplier still needs an intake bridge?

### Takeaway

Yes: product certainty and machine-readable order delivery are separate issues. The best project framing is transferring an already specified customer PO into a checked supplier sales-order draft, with ambiguous product matching reserved for exceptions.

### Cited Findings

- Mistral explicitly starts its PO instructions with choosing products from its website and then putting names, sizes and quantities into the customer's document. Its published workflow includes supplier verification and pro-forma invoicing. This establishes a structured business procedure, but not whether verification/rekeying is manual. [Mistral purchase orders](https://mistralni.co.uk/pages/purchase-orders)
- Workplace Gloves asks emailed orders to contain product names/codes, quantities and sizes. Thus email orders need not be vague natural-language shopping requests. [Workplace Gloves purchase orders](https://workplacegloves.co.uk/purchase-orders-b2b/)
- **NMBS OnePlace**, in the UK merchant/supplier ecosystem, explicitly offers email/upload of PDF or XML POs produced by the buyer's back-office system. It describes validating criteria such as active product codes and minimum order value, then forwarding successful orders. It offers PDF mapping and asks for ten single/multipage sample POs to configure it. This is direct operational evidence for an existing bridge between buyer-generated documents and supplier ordering. [OnePlace Straight Through Ordering](https://www.oneplace.co.uk/order-mapping/)

### Inferences

- A buyer can choose a known SKU while still sending the information as a PDF instead of directly into the supplier database. The commercial problem, where it exists, is transmission/integration and exception handling, not necessarily uncertainty about the product.
- Our demo should start with an exact-code PDF PO with multiple lines. Extract identifiers, match exact catalogue codes, check price/unit/address, review and export. A vague 'same bearings as last time' case is an exception, not the core sales story.
- OnePlace demonstrates that the bridge already has non-custom solutions. Before building for a customer, compare configuring an existing integration, PDF mapping or supplier portal against custom AI development.

### Gaps

- None of these pages proves the named suppliers are currently retyping orders. Existing automation could already handle email intake.
- Public evidence cannot establish whether a custom app would outperform OnePlace or a customer's current ERP/import tools for a specific firm.
- Whether buyer reluctance, system requirements, approval controls or convenience drives email usage needs direct workflow discovery, not an assumed narrative.

## How do website checkout, PunchOut and EDI differ?

### Takeaway

A website cart captures customer choices. PunchOut connects that shopping experience to the buyer's procurement system. EDI/eOrdering transfers business documents system to system. When reliable structured data already reaches the supplier's order system, AI document extraction adds little value.

### Cited Findings

- **The Reynolds Company** describes a PunchOut flow: enter its catalogue from the buyer's procurement system, build a cart or open a quote, return line-item details into procurement, and submit the PO directly into its Infor SX.e ERP. This is a US industrial supplier example used to explain the mechanism, not UK adoption. [Reynolds PunchOut](https://www.reynoldsonline.com/solutions/esolutions/punchout)
- **RS Spain** describes eOrdering using XML, IDOC and cXML from the customer's ERP/purchasing tool. Transmission can be HTTP/HTTPS, an email with an XML attachment or an eProcurement provider; received data is integrated into RS's ERP. Thus 'arrived by email' does not necessarily mean an unstructured document needing AI. [RS eOrdering](https://es.rs-online.com/web/content/servicios/soluciones-compras/eordering)
- **Fastenal's 2025 annual filing** describes EDI as connectivity between its system and customers' procurement systems, directly or through a procurement network/marketplace, exchanging POs, advance shipment notices and invoices. It is a historical annual-period statement, not a statistic about today's UK small suppliers. [Fastenal 2025 Form 10-K](https://www.sec.gov/Archives/edgar/data/815556/000081555626000009/fast-20251231.htm)
- **Infor purchasing documentation** defines EDI as electronic document exchange between trading partners, including purchase orders and acknowledgments. This is software-vendor documentation describing capability, not independent evidence of adoption or accuracy. [Infor EDI purchasing](https://docs.infor.com/ifsm/2026.10/en-us/ifsmolh/ifsmpurchug/cmo1450797951275.html)

### Inferences

- Intake should distinguish structured XML/CSV/API messages from human-readable PDFs/emails. Parse supported structured formats deterministically; do not pay a model to reinterpret data already provided in a formal schema.
- Website existence is not a disqualifier. Full order-system integration covering the relevant channel is the stronger disqualifier for this project.
- Recommended customer discovery question: 'Show us what happens between receiving this PO and seeing the sales order in your system.' Follow that with measurement and examination of existing import/EDI options.

### Gaps

- No evidence obtained for the cost or implementation burden of adopting EDI/PunchOut for the proposed fictional company; avoid assuming it is unaffordable or inaccessible to small firms.
- No reason to claim an AI approach is generally better than a website, EDI or fixed document mapping. That depends on document diversity, existing tools, exceptions, volume and integration effort.
