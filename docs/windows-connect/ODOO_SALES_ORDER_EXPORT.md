# Odoo 18 sales order lines

PackProof Connect can read a flat report from one Odoo database and company and propose an order source during setup. Each row represents a confirmed sales order line. A later packing report can join the same Proof when its order reference contains the Odoo order’s external ID and the operator confirms which source supplied that reference.

## Export contract

Use a dedicated folder for each database and company. Configure the existing reporting job for the `sale.order.line` model. Repeat the order and company fields on every row, including additional lines of the same order. Keep the selected column layout consistent across later reports. Use the following technical headings in a CSV, TSV or pipe-delimited report.

| Column | Meaning |
| --- | --- |
| `id` | External ID of the sales order line. Keep it stable across exports. |
| `order_id/id` | External ID of the parent sales order. A packing export that carries only the displayed order number requires a separate verified cross-reference. |
| `order_id/name` (optional) | Odoo’s display name, such as `S00071`. Open the order’s evidence and inspect its source record to see this value. The Proof’s primary order reference and all joins use the external ID, even when two companies use the same display name. |
| `company_id/id` | External ID of the company that owns the order. |
| `product_uom_qty` | Ordered quantity in the line’s reported unit. Preserve the decimal value. |
| `product_uom/name` | Reported unit of measure. Keep the reporting language consistent across connected exports. |
| `product_id/default_code` | Product’s internal reference (SKU). Include the column. A blank value leaves the SKU unavailable. |
| `state` | Confirmed order state, either the technical value `sale` or the English export value `Sales Order`. Any other state sends the entire file to review. |
| `ReportAsOf` **or** `SourceRevision` | Include exactly one. The reporting job supplies a timestamp for its source snapshot, with an explicit UTC offset, or a monotonically increasing numeric revision for each line. Replaying the same source observation carries the same revision. |

Example prepared report with two rows from the same company:

```csv
id,order_id/id,company_id/id,product_uom_qty,product_uom/name,product_id/default_code,state,ReportAsOf,order_id/name
exports.line_204,exports.order_71,base.main_company,2.500,Units,SKU-050,sale,2026-11-18T13:00:00Z,S00071
exports.line_205,exports.order_71,base.main_company,1,Box,SKU-019,sale,2026-11-18T13:00:00Z,S00071
```

Odoo’s standard export can use translated field labels and localized dates. Its `write_date` describes a record modification. The two revision columns above are supplied by the reporting integration. A source-consistent snapshot can use `ReportAsOf`; a file’s creation time cannot establish that snapshot. Keep cancellations and returns on their own explicit lifecycle feeds. An order disappearing from a report does not establish that it was cancelled.

Odoo documents relation external IDs in its import/export manual. Its 18.0 implementations define the technical fields, order states and export headings. [Export and import data](https://www.odoo.com/documentation/18.0/applications/essentials/export_import_data.html) · [Sales order line model](https://github.com/odoo/odoo/blob/18.0/addons/sale/models/sale_order_line.py) · [Sales order states](https://github.com/odoo/odoo/blob/18.0/addons/sale/models/sale_order.py) · [Export controller](https://github.com/odoo/odoo/blob/18.0/addons/web/controllers/export.py) · [ORM date and time conventions](https://www.odoo.com/documentation/18.0/developer/reference/backend/orm.html)
