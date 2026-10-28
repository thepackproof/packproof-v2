# Proof dashboard

The dashboard lives inside the existing authenticated PackProof web app at `/proofs`.
It uses the existing Proof search and connection-health endpoints. Capture,
confirmation, playback, sharing and evidence-package export stay on their
existing authorized screens.

## Open the dashboard

Build the web app with `VITE_PACKPROOF_CLIENT_DASHBOARD=true`, sign in, and open
`/proofs` on a viewport wider than 760 pixels. No separate Signal flag is required.
The flag is a Vite build-time setting: changing a deployed server environment
without rebuilding the web bundle does not enable it. The matching API candidate
and its additive migrations must already be installed.

Narrow screens retain the existing capture/task experience. Turning the dashboard
flag off restores the prior shell selection and Proof list. This source change
does not deploy a public dashboard or change anyone's access.

For a development preview, run `npm run review` in `web` and open
`http://127.0.0.1:5180`. The preview is served only in development on loopback,
uses fictional sample records, blocks external requests, and has no API proxy.
Review controls provide mixed statuses, Ready records, an empty account,
57-record pagination, search errors, stale refreshes, offline state, connection
problems and large text. Reset or replay the dashboard tour from those controls.
Preview records do not qualify a live merchant workflow or physical capture.

## What users can do

- Scan four status cards: Needs attention, Awaiting capture, In progress and Ready.
  Counts always describe records loaded in the current filtered view; they are
  not fabricated account totals. Select a card to request that status from the server.
- Search by item, order reference, tracking number or Proof ID. Use status,
  inclusive UTC creation dates and the connected store to narrow the view. Active
  filter chips can be removed individually. Invalid date ranges are rejected
  before a request. Filters survive browser back/forward navigation and refresh;
  signed pagination cursors and credentials are never written into the URL.
- Open a shipment's existing Proof detail to review evidence, activity, sharing,
  recovery and package exports. Suggested next steps prioritize actionable records
  among the loaded results. The ready-intake section remains available.
- Jump to the order queue, locally saved recordings or invitations.
- Export the currently loaded search summaries as CSV. This does not download the
  signed evidence package or silently fetch the rest of the account. CSV values
  escape spreadsheet formulas, quotes, commas and newlines. Offline, unconfirmed
  or refreshing results cannot be exported.
- Check store authorization and last sync. Open health for one chosen connection
  to see source freshness, pending updates, discovered-order coverage and the
  appropriate next step. No health request is sent for every connection; fixes
  use the existing Integrations workflows. Finalized counts are explicitly
  separate from preservation readiness.

Ready means the server has confirmed finalization and the required preservation
receipts. It is not a claim about delivery, physical truth or dispute outcome.
Server received time is labeled separately from physical recording time.

## Guided first visit

First-time users see an invitation to a six-step dashboard tour. It highlights
the overview, search, filters, records, connections and New Proof control while
explaining what each does. The tour never creates or changes a Proof.

Users can go Back or Next, Skip, finish, resume an interrupted tour or select
Take dashboard tour again. Versioned progress and dismissal are saved separately
for each signed-in account in that browser, with a memory fallback if browser
storage is blocked. This does not mark the existing server onboarding complete.
The tour coordinates with the existing app tutorial and other dialogs, contains
keyboard focus, supports Escape, restores focus on close, repositions its
highlight, and respects reduced-motion preferences.

## Refresh and recovery behavior

Visible first-page results refresh every 30 seconds unless users pause refresh.
Hidden pages, offline state, active modal dialogs and ongoing page requests do
not trigger competing background searches. After additional pages are loaded,
the dashboard offers a fresh first-page reload instead of removing the user's
place automatically. The topbar refresh also reaches dashboard search.

Failed background refreshes retain prior results with an explicit unconfirmed
status and a retry action. Permission/session denials clear old results. Signed
cursor failures retain the current list and offer retry or a fresh first page.
Late responses cannot replace a newer filter/account view. Account changes reset
the workspace and tour scope. Reconnection requests fresh state. Search requests
remain bounded; the enhanced desktop view no longer also downloads the entire
legacy list behind the scenes.

## Validation boundary

Automated UI tests cover navigation, responsive reachability, filters, paging,
stale/offline/auth behavior, exports, connections and the tour. Typechecking and
production builds apply to the same source. Browser screenshots and actual
device/usability qualification remain distinct checks; do not claim them from
jsdom tests or fictional preview fixtures. The broader live release gates remain
in [RELEASE_GATES.md](RELEASE_GATES.md).
