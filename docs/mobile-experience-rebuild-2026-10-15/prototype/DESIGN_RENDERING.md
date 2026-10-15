# Design render provenance and limits

The PDFs are review artifacts for `G1-2026-10-15-r1`. They are static HTML/CSS document renders, not screenshots from a live browser or Android. All after-state content is synthetic.

## Deliverables

- Screen atlas: all 12 primary compositions in light/dark at 100% and 200% text, plus recovery, policy and empty-state examples.
- State atlas: applicable empty, loading, error and offline compositions in both themes, plus authorization pending/canceled/failed/expired examples. The clickable control identifies N/A combinations explicitly; it does not invent a remote dataset for local menus.
- S01–S09 comparison: supplied plan reference beside proposed composition, with source qualifications. Identifiers were removed through PDF redaction before sanitized images were embedded in the delivered comparison. Supplied originals are excluded from the public repository.
- One-page core copy sheet: exact core copy and required declaration. Full state copy and tokens remain in `COPY_AND_TOKENS.md`.

These are first-viewport images. Large type legitimately needs scrolling; a screenshot boundary does not establish that offscreen controls are inaccessible. The interactive fixture is the place to inspect scrolling. No native 360 dp equivalence, actual browser geometry, keyboard behavior or TalkBack result is claimed.

The final packet contains 151 frames: 63 in the 16-page screen atlas and 88 in the 22-page state atlas. The comparison has nine pages and the core copy sheet has one page.

## Reproduction

Use `export-design-frames.cjs` with Node and jsdom 30.1.2. It exports script-free phone HTML using the prototype's published snapshot API. Then use `render-design-atlas.py` with WeasyPrint 70, PyMuPDF and ReportLab; select `core` or `states` as the fourth command-line argument (including the script name). `build-copy-sheet.py` takes its output PDF path. `build-reference-comparison.py` additionally requires the founder-supplied reference images, which are deliberately not committed.

The document export has explicit compatibility adjustments: computed font values, fixed first-viewport boundaries, document-layout replacements for button elements, closed-details handling, SVG strokes and print-safe navigation positioning. The original interactive HTML is unchanged by export. `build-review-site.py` assembles the static site using markdown2 2.5.5. These adjustments make the PDF useful for design review but prevent treating it as a pixel-equivalent browser screenshot.

## Visual QA boundary

The generated pages were checked for readable labels, aligned columns, overlapping content, correct theme grouping and redacted reference identifiers. Initial document-renderer control sizing problems were corrected. All exact source revisions, final page/frame counts and file hashes are recorded in `render-manifest.json`.

Remaining evidence: live browser/native layout, real Android font scaling and safe areas, physical touch targets, actual original playback and all G0/G2/G3 device acceptance. An atlas or passing DOM suite cannot close those gates.
