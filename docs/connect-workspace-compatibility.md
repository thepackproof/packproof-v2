# Connect multi-source compatibility

The Windows service identifies each captured revision by SHA-256 and runs a bounded reader before attempting an order interpretation. The table describes the candidate build. Customer verification requires the named product version, actual transport, duplicate deliveries, corrections and recovery on an authorized connection.

## Format and profile register

| Family | Recognized and parsed scope | Business mapping | Evidence and qualification |
| --- | --- | --- | --- |
| CSV, TSV, semicolon, pipe | Quoted separators and newlines, strict encoding, BOM, configured preamble | Explicit journey fields or approved order-line heading map | Delimited regression cases and picking fixture |
| Fixed-width | Configured prefixes and character positions distinguish record types | Supplied layout and field lineage | Header/detail, padding and incomplete-row cases. Byte-oriented multibyte layouts need their own profile |
| JSON / JSONL | Nested arrays, scalar/null distinction, exact numeric tokens and complete UTF-8 line offsets | Explicit references and line semantics. Resource URLs stay inert | Order, label, handoff and delivery fixtures |
| XML / SOAP | Namespaces, repeated elements, bounded embedded JSON/CSV under an explicit profile, DTD prohibited | Explicit journey fields or confirmed mapping | Package XML and namespaced SOAP test |
| XLSX / data-only XLSM | Sheet/table selection, raw numeric text, formula/cache pair, workbook epoch and date styles | String identifiers retain leading zeroes. The order map can bind a sheet | Controlled two-line XLSX fixture. Office is never launched |
| Binary XLS | BIFF8 worksheets, cell types, date, formula/cache and sheet/row/column location | Same approved field semantics. Formula results remain separate from ordinary identity values | Native test writes and reads a BIFF8 sample. Older and encrypted formats need qualification |
| X12 004010 | ISA/GS/ST/SE/GE/IEA, functional group, release and control counts | Synthetic header/reference profiles for 850, 855, 860, 865, 940, 945, 943, 944, 856, 846, 947, 204, 990, 214, 210 and 997. Selected segments emit line, quantity, hierarchy, tracking status and acknowledgment claims with exact element locations | 16 per-transaction fixtures. 997 describes technical acknowledgment. Partner-specific loops and code mappings require a partner guide |
| X12 005010, X231, X231A1 | 999 implementation acknowledgment | Functional group reference and raw reported response code | Independent 999 fixture. No physical delivery or receipt is inferred |
| EDIFACT D.02B | UNA, UNB, UNH, UNT, UNZ, escape characters and control values | Synthetic ORDERS, ORDRSP, ORDCHG, DESADV, RECADV, INVRPT, IFTMIN, IFTSTA, INVOIC and CONTRL headers. LIN, QTY, RFF, DTM, CPS, GIN and UCI claims retain identifiers, qualifiers and member locations | Ten per-message fixtures. Partner extensions and code-specific business rules require separate qualification |
| EPCIS 2.0 JSON / JSON-LD / XML | Event list, event type, action and EPC collection | Aggregation and association retain parent/child EPCs and action. Order association needs an approved bridge | JSON/XML fixture. Remote contexts are never fetched |
| Text PDF | Bounded word extraction | Derived text with a page and rectangle in PDF points | Native text PDF fixture |
| Scanned PDF / JPEG / PNG / TIFF | English OCR and barcode decoding in an isolated process. TIFF frames and supported PDF image objects have separate locations | OCR returns confidence and pixel regions. The barcode decoder reports detected points | Native suite covers PDF, JPEG, PNG and TIFF. Windows qualification is distinct from structural tests |
| ZPL | XA/XZ boundaries, FD data and selected barcode commands | Exact field with command offset. Graphic-only, custom encoding or custom delimiter labels retain original | ZPL/PRN tests. EPL and other languages require qualification |
| ZIP / GZIP | Bounded in-memory extraction, member hash and location, duplicate/path checks | Contained reports retain member lineage | Archive tests cover a directory and rejected traversal |
| DOCX | Main document paragraph text with active content excluded | Paragraph text is derived | Document-specific interpretation needs customer samples |
| HEIC, WebP, MP4, MOV | Container signature and original retention | Decoder/visual interpretation pending. A firm join needs an explicit source link | No qualified HEIC/WebP/video interpretation in this candidate |
| HTML, EML/MSG and analytical formats | Original retention where authorized | Dedicated reader pending | These formats do not establish an order event |

The structural reader version is **packproof.readers/1**. **packproof.explicit-order-journey/v1** interprets declared identities, relationships and line facts. **packproof.order-columns/v1/&lt;digest&gt;** identifies the chosen order, line, version, quantity, unit and optional SKU columns. Its line identity includes the source, order and actual line. **packproof.workflow-columns/v1/&lt;digest&gt;** binds ordinary picking, packing, shipping, handoff, delivery or returns columns to approved source instances. Tracking identity includes the carrier, account and originating shipment date/period. A status such as in transit yields a source observation. Physical completion requires the corresponding supported source assertion. Missing stable fields, ambiguous candidates and schema drift require review.

The reader library accepts explicit encoding, preambles, fixed layouts, record selection and field mappings. An operation needs a configured profile for those settings before collection. Unknown layouts stay available for review.

## Direct integration qualification

| Product | Recognized product configuration | Parsed / mapped customer payload | Connected to order workspace | Verified version | Required input |
| --- | --- | --- | --- | --- | --- |
| Oracle WMS | Pending | Pending | Pending | Pending | Export template, entity IDs and authorized update interface |
| SAP warehouse systems | Pending | Pending | Pending | Pending | Installed release and configured OData/SOAP/IDoc interface |
| Dynamics 365 SCM | Pending | Pending | Pending | Pending | Business event and matching header/line entity |
| Manhattan | Pending | Pending | Pending | Pending | Entitled API product/version, limits and replay behavior |
| Infor WMS / ION | Pending | Pending | Pending | Pending | Enabled BOD events, namespace and status/unit translations |
| Extensiv | Pending | Pending | Pending | Pending | Signed event and scoped resource-read sample |
| Descartes Peoplevox | Pending | Pending | Pending | Pending | Actual template and subscription/update mechanism |
| Descartes MacroPoint | Pending | Pending | Pending | Pending | Freight identity, event export and correction behavior |
| NetSuite | Pending | Pending | Pending | Pending | Account schema, internal IDs and incremental read |
| ShipStation | Pending | Pending | Pending | Pending | Tenant version, webhook/detail/label and replay samples |
| Deposco | Pending | Pending | Pending | Pending | Customer read scope and representative entities |
| Blue Yonder | Pending | Pending | Pending | Pending | Product/version documentation and authorized access |
| Infios / HighJump | Pending | Pending | Pending | Pending | Installed WMS and authorized EDI/export interface |

The folder collector can inspect exported files independently of the system that produced them. The isolated event harness exercises synthetic source behavior. Tecsys, Softeon, Logiwa, Epicor and customer-built systems require their own qualification inputs.

## Verification

From **connect-windows**, run the following on Windows with the pinned SDK.

    dotnet test service-tests/PackProof.Connect.Service.Tests.csproj -c Release --filter "FullyQualifiedName~WorkflowProfileTests|FullyQualifiedName~SourceReaderTests|FullyQualifiedName~DocumentReaderTests|FullyQualifiedName~ControlledOrderJourneyTests"

Cross-format fixtures are in **examples/multisource-journey/fixtures**. Structural checks, Windows native tests, packaged invocation and live customer operation each require their own evidence.

References include [GS1 EPCIS artefacts](https://ref.gs1.org/standards/epcis/artefacts), [UNECE D.02B](https://service.unece.org/trade/untdid/d02b/trmd/trmdi1.htm), [X12 transaction sets](https://x12.org/products/transaction-sets), [NPOI](https://github.com/nissl-lab/npoi), [PdfPig](https://github.com/UglyToad/PdfPig), [ZXing.Net](https://github.com/micjahn/ZXing.Net) and [Tesseract .NET](https://github.com/charlesw/tesseract).
