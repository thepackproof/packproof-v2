# Windows Connect usability verification

## Packaged renderer

The Windows Connect CI job runs `node node_modules/electron/cli.js --disable-gpu scripts/check-renderer-layout.cjs --packaged-workspace` from `connect-windows` after packaging. It loads the renderer and preload from the built application's ASAR and supplies isolated source, permission and order responses.

The layout check covers every setup step, Overview, assembled order detail, empty and ambiguous reports, an interrupted source and a pending local copy in light and dark themes. It checks viewport overflow, visible control bounds and accessible headings at 100%, 125%, 150% and 200% emulated display scale. The subsequent walkthrough uses real keyboard input at 200% to complete the following sequence.

- Select sales records, inspect the business reference, and include an existing partner connection.
- Reopen the saved step and reuse the sales location for picking. Add an empty packing folder and confirm the meaning of a shipping reference.
- Identify the assembled order, its package and the source of its shipping event.
- Select the output folder and verify every location, applicable history, ongoing reads, retained originals and online availability in the access summary.
- Start collection. An injected browser decision lets the renderer discover the new status through its regular polling. Open Orders and retrieve the saved proof by its reference.

The walkthrough checks keyboard focus and the accessible page heading, and captures the ambiguous reference, final access review and committed order at 200%. The CI artifacts contain `workspace-layout.json` and the PNGs from `build/workspace-screens`. Folder dialog selection, the server decision and the service data are test inputs.

## First-time operator session

Use the release-candidate installer on Windows 11 and the isolated order journey. Give the participant only the paths the operation uses for order records, picking, packing, shipping and saved proofs. Include one shared location. Let them use their normal display scale, keyboard, and assistive technology.

Ask the participant to connect those locations, identify the example order, describe which source contributed its shipping information, choose the proof destination, start collection and find the same order again. Ask what the computer can read and what PackProof keeps before they approve. Wait for their answer before explaining a control or term.

Repeat with an empty source and with an ambiguous order reference. Observe whether the participant distinguishes waiting from an error, understands what the reference question asks, and can leave the source pending. Record the screen, action and wording for each point where the participant needed help.

Capture installer version, Windows version, display scale, input method, completion time, interventions, source names, selected destination and final proof revision. Use synthetic records in screenshots. Record actual Narrator/other screen-reader announcements and native picker focus when those devices and users are available. The product usability gate closes after a participant completes the task and observed blockers are corrected and rechecked.

The automated accessibility-tree and keyboard results, native dialog verification, and first-time participant observations are separate entries in the release ledger.

