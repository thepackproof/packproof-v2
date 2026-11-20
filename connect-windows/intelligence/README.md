# Windows export discovery

Select **Connect my records** in PackProof Connect to look for order exports. Select another record type in setup to look for picking, packing, shipping, handoff, delivery or return exports, or for photos and documents from packing and shipping. Each result shows the folder and what PackProof recognized. Choosing a result lets the background service inspect a sample locally. The same sample takes priority in the first Proof preview.

| Export | What setup can do |
| --- | --- |
| Microsoft Dynamics 365 Sales order lines V2 | Confirm a sales order and its lines from one legal entity. Include `DataAreaId` and either `SourceRevision` or a timezone-qualified `ReportAsOf` on each row. |
| Odoo 18 confirmed sales order lines | Confirm order and line external IDs, company, quantity and unit in a prepared export. The [export guide](../../docs/windows-connect/ODOO_SALES_ORDER_EXPORT.md) includes an example. |
| Shopify Orders CSV | Recognize the standard layout and explain which fields a line-level Proof still needs. |
| Window Book Enterprise Shipper daily shipping report | Recognize the report by its columns and explain how to supply a versioned shipment reference. Setup checks the documented default report folder when looking for shipping records. |
| Packing or shipping photos and documents | In a dedicated evidence folder, look for matching JPEG, PNG and PDF file signatures. A separate order or package reference links the original to a Proof. |
| Other delimited operational reports | Suggest a workflow when its columns identify one record type. The collector checks the rows and asks which connected source owns references before using those relationships. |

Discovery checks dedicated subfolders under Windows Documents and Downloads, the prepared PackProof export folder and the specific shipping-report location. It samples local CSV, TSV and pipe-separated headers and supported evidence file signatures within fixed limits. A recognized layout can still need extra fields or permission for the background service to read the folder. **Choose a folder myself** also works for sources saved elsewhere.

Review the full folder path before activating collection. Approval applies to existing and future originals in that folder. Choose a folder dedicated to the records you intend to share.

## Extending the catalogue

Each entry in [export-catalogue.json](export-catalogue.json) identifies its workflow, required headers, vendor reference and operator guidance. A profile with an order mapping also declares the company scope, order and line keys, quantity, unit and source revision inputs. The interactive Windows bridge and the background collector embed the same catalogue. Add a representative positive fixture and a near-miss fixture when introducing a new signature. Exercise the native reader with a corrected or repeated order before enabling a mapping that can update a Proof.
