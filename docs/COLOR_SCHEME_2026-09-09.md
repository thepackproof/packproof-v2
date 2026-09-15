# Approved color scheme — September 9, 2026

The user-supplied values supersede earlier paper palettes. `mobile/src/theme/tokens.ts` supplies native colors and the web ThemeProvider; web CSS defaults and public-page brand roles match the approved light palette before hydration. Public/shared pages remain light independently of the existing optional workspace dark preference. Dark mode retains cool dark surfaces and corresponding readable semantic text, with the same solid blue primary button colors.

| Role | Exact light value |
| --- | --- |
| Canvas | #E9EEF4 |
| Cards/sidebar | #F7F9FC |
| Insets | #E2E8F0 |
| Dividers | #CBD5E1 |
| Text / supporting text | #23262D / #526174 |
| Primary / hover / pressed | #1769D2 / #1255AD / #104790 |
| Selected / secondary action | #E6F0FF |
| Success / background | #14805E / #E5F5ED |
| Attention / background | #895000 / #FFF1D6 |
| Error / background | #B42318 / #FEECEB |
| Logo blue / green | #2583E9 / #20AA70 |

Primary actions use white text. Selection, pending, recoverable interruption, failure, and recorded success remain distinct. Native and web badges share one status-tone function, preserving visible labels and icons. Awaiting shipment, pending invitations, and waiting for a buyer stay neutral. Actions on completion screens remain blue.

The specified success foreground/background pair measures 4.35:1. Both exact colors are preserved: small completion badge labels use primary text while check icons use success green on the pale green background. Green small text on the card surface measures above 4.5:1. Other approved button, attention, error and secondary text pairings pass 4.5:1. Live camera/video canvases retain dark playback surfaces; empty recording areas use the neutral inset.

Existing vector path geometry is retained and its blue/green fills are updated to the approved bright accents; mobile PNG assets are rasterized from those masters. Monochrome/reversed assets remain monochrome.

Scope: presentation only. No changes to order binding, capture orchestration, evidence integrity, server lifecycle, or feature activation. Mobile TypeScript and the production web build are checked; browser/device acceptance and release of a fresh Android bundle are separate from this source change.
