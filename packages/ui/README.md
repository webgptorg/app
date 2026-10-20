# @ptbk/ui

The design system shared by `apps/engine-ui` and `apps/dashboard`: design tokens (Tailwind 4 theme, light and dark), accessible components, form primitives, TanStack Table wrappers (`DataTable`), and i18n helpers that work with each app's Paraglide catalogue.

CSP-safe by construction (no runtime style injection, no inline scripts, no `innerHTML`), because engine-ui runs under the engine's strict CSP. It imports no app and no contract package; app-specific concerns such as permissions and API clients stay in the apps. Private, not a contract. Plan: task U-02 ([ADR 0007](../../docs/adr/0007-frontend-stack.md)).

## Using it

```css
/* the app's Tailwind entry */
@import 'tailwindcss';
@import '@ptbk/ui'; /* the package's `style` condition: src/theme.css */
@source '../../node_modules/@ptbk/ui/src';
```

```tsx
applyTheme(readThemePreference(storage), document.documentElement, matchMedia); // first statement of main.tsx
<UiProvider messages={uiMessages} locale={locale}>
  <App />
  <Toaster />
</UiProvider>;
```

One entry, `src/index.ts`, is the whole public API; `@import '@ptbk/ui'` in CSS resolves the same entry's `style` condition. Apps build their router link from `Anchor` (`createLink(Anchor)` in TanStack Router), map their Paraglide catalogue onto `UiMessages` (a missing message is a type error), and inject storage for preferences.

## Tokens (ADR 0015)

Three layers, all CSS custom properties:

1. **Primitives** (`--ptbk-*`) in `src/theme/primitives.css` only: palette, type scale, spacing unit, radii, shadows, durations, easings. The only file with colour literals.
2. **Semantic** tokens in `src/theme/semantic.css`, with light (`:root`) and dark (`.dark` on `<html>`) values and reduced-motion overrides: `--color-surface`, `--color-raised`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-accent`, `--color-success` … `--color-focus`, `--color-live`, `--color-identity-1…6`, `--font-*`, `--text-*`, `--radius-*`, `--shadow-*`, `--ease-*` and the motion durations `--motion-state`, `--motion-enter`, `--motion-exit`, `--motion-seal`, `--motion-live`, `--motion-spin`. Their names follow Tailwind's namespaces, and `theme.css` maps each to a utility (`bg-surface`, `text-text-muted`, `rounded-control`, `shadow-raised`, `ease-enter`); Tailwind's default palette, radii, shadows and fonts are cleared, so only tokens exist.
3. **Component** tokens in each module's CSS file (`--button-primary-bg`, `--trust-mark-fp-1` …), defaulting to semantic tokens and used as `bg-(--button-primary-bg)`.

A redesign or white-label theme replaces primitives and semantic mappings; components and features do not change. Tests hold the boundary: `test/token-boundary.test.ts` fails on a primitive outside `src/theme/` or a colour literal outside `primitives.css` in this package or engine-ui; `test/contrast.test.ts` checks WCAG contrast for every semantic pair and every component `-text`/`-bg` pair in both themes; engine-ui's `test:csp` swaps the primitives for a test palette and sees the rendered gallery change.

## Modules

One component per folder in `src/components/<name>/`: `<name>.tsx`, `<name>.css` (its tokens), `<name>.gallery.tsx` (every state, collected by `src/gallery.tsx`) and `<name>.test.tsx` (keyboard use, accessible name, axe in both themes). Composite patterns (`DataTable`, `EmptyState`, `TrustMark`, `EngineSwitcher`) are modules too, and `src/forms/` is the form layer over TanStack Form. Apps never restyle a component; they use variants or tokens. Components take plain props for what the member may do (`hidden`, `disabled`, `disabledReason`); permission logic stays in the apps.

## Motion

Durations and easings are tokens; most motion is CSS transitions and keyframes behind Tailwind's `motion-safe:`. Under `prefers-reduced-motion` the motion tokens collapse to a short fade or zero, `useReducedMotion()` lets JS do the same, and `withViewTransition()` skips the View Transitions API. `motion` (CSSOM-based, CSP-safe) is only reachable through `loadMotion()`/`useMotion()`, a dynamic import, so it never lands in an entry chunk.

## CSP

engine-ui runs under the engine's CSP with Trusted Types, so the same ESLint bans apply here (no `dangerouslySetInnerHTML`, `innerHTML`, string `style` attributes), plus: no runtime `<style>`, no headless UI library that injects styles, native `<dialog>` and the Popover API for overlays, fonts self-hosted from `src/fonts/` (OFL, byte-identical to `@fontsource-variable`, checked by `test/fonts.test.ts`). React's `style` prop (CSSOM) is fine and used only for computed positions (menus, virtual rows). There is no user-visible string literal: everything comes through `UiMessages` or props, and ESLint refuses JSX text outside tests and gallery entries.

## Tests

`bun run --filter @ptbk/ui test`: the `dom` project (jsdom, `src/**/*.test.tsx`, with stand-ins for `<dialog>`, the Popover API and `matchMedia` in `src/testing/dom-gaps.ts`) and the `node` project (`test/`: tokens, contrast, fonts, lint rules), with 90% line and branch coverage. Real-browser behaviour (top layer, focus, contrast, motion) is checked against the gallery by engine-ui's `test:csp`.

## Engine fingerprint

`TrustMark` carries the engine fingerprint: a code and a pattern that users compare between engine-ui's security page (U-06) and the dashboard's engine list (D-06), like Signal safety numbers. Both render it through `TrustMark` or `deriveEngineFingerprint` from this package and test against [`fingerprint-vectors.json`](src/components/trust-mark/fingerprint-vectors.json), so the same engine ID shows the same mark everywhere by construction. It is a recognition aid; the security property stays the engine ID in the hostname.

Derivation `ptbk-fingerprint-v1` (decided 2026-10-20):

1. `digest = SHA-256(UTF-8("ptbk-fingerprint-v1") ‖ UTF-8(engineId))`, the prefix immediately followed by the engine ID with no separator (the prefix has a fixed length, so the input is unambiguous).
2. Digest bits are read most significant bit first, byte 0 first.
3. Code: bits 0–99 as twenty 5-bit groups, each mapped to the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (uppercase, no check symbol). Shown in five groups of four joined by `-`: `XXXX-XXXX-XXXX-XXXX-XXXX`. 100 bits make a targeted key search for a matching code infeasible.
4. Pattern: bits 100–114 fill a 5×5 grid row by row over columns 0–2 (cell `(row, column)` is bit `100 + 3 × row + column`, `1` = filled); column 3 mirrors column 1 and column 4 mirrors column 0.
5. Colours are positional and not part of the fingerprint: a filled cell takes `--trust-mark-fp-N` with `N = ((row + min(column, 4 − column)) mod 6) + 1`.

The vectors were computed independently of the TypeScript code (Python `hashlib`, digests cross-checked with OpenSSL). Changing any step changes every engine's mark, so a new derivation gets a new prefix (`ptbk-fingerprint-v2`) and new vectors, and engine-ui and the dashboard switch together.
