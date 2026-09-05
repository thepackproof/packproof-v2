# PackProof experience update

The supplied navigation, dashboard, filter, timeline, location-card, alert, and document-viewer references are adapted to PackProof's navy (#0B1220), blue (#13A8E8), and green (#0DCE70) visual system. Existing React, authentication, API, and evidence-integrity paths remain in use.

## Product behavior

- Public product menu links to real pages and the sample workspace. Mobile navigation, collapsible workspace navigation, and the existing appearance preference share accessible controls.
- Dashboard totals and 7/30-day activity come from actual Proof summaries. Created and finalized dates are counted independently in the viewer's local time. No revenue or growth values are invented. Filters affect records and are removable individually or together.
- Chronology is displayed in timestamp order, with source/category filters and an explicit distinction between the frozen core and subsequent shipment observations. Public progress retains the API's recorded/current/upcoming milestones.
- Shipment scans can be selected and their reported coordinates viewed in an expandable OpenStreetMap frame. Text-only observations provide a location-search link. Existing EasyPost normalization has no coordinate fields, so those observations use the text fallback. No automatic geocoder, estimated route, or live GPS position is fabricated. Only coordinates are sent to the map frame; Proof identifiers, auth tokens, and tracking numbers are not part of its URL. Map availability remains external; an Open map link is always available for a mapped observation.
- PDFs, video, images, and other committed files load through the existing authorized or scoped evidence loader. PDF previews use the browser's viewer with an original-byte download. MIME labels are normalized, stale requests cannot replace the selected record, and object URLs are revoked on replacement/navigation/unmount.
- The backend export filename map now includes PDF and normalized MIME labels. This source fix is separate from the deployed web assets; applying it to the AWS API requires that backend release.
- `/sample` demonstrates the same dashboard, map, and timeline components with explicitly labeled illustrative data. No customer data is used.

## Verification

- Web type checking and all 92 web unit/integration checks pass, including 11 targeted checks for coordinates, map selection, chronology, activity boundaries, PDF previews, retries, and stale loading.
- The existing backend lifecycle and portable evidence-package checks also pass (2 checks).
- Production build is checked before publishing. Agent-side browser QA was not requested and was not run.
- Cloudflare custom-domain activation remains pending DNS validation. This update does not change DNS or the API's canonical web origin.

## Map references

- [OpenStreetMap embedding](https://wiki.openstreetmap.org/wiki/Export#Embeddable_HTML)
- [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)

The embedded provider retains its own controls and attribution; the PackProof overlay is positioned away from zoom controls and attribution.
