# Evidence in Motion presentation tokens

`tokens.v1.json` is the versioned presentation source. It identifies the named Figma contract, preserves source references, and separates brand primitives from light/dark semantic roles. A decorative mint value does not authorize a saved state.

Run `npm run tokens:eim` after an intentional token change. Check in both generated outputs. `npm run tokens:eim:check` verifies their source digest/content, actual consumer imports, and absence of inline shell-role overrides in web/desktop presentation CSS. The generator uses only Node built-ins and does not change app state, dependencies, evidence, or backend contracts.

Consumers:

- Native `mobile/src/theme/signal.ts`, `tokens.ts`, and `motion.ts` consume generated TypeScript.
- Web `ThemeProvider.tsx` consumes generated primitives; `signal.css` imports generated scoped CSS.
- Desktop imports the same web stylesheet and uses its generated semantic aliases in its renderer stylesheet. Privileged code does not consume presentation preferences.

Native static font availability is recorded in `fontStatus`. A font target is not an installed-device fidelity claim. Platform acceptance remains in `docs/evidence-in-motion-apps/acceptance.md`.
