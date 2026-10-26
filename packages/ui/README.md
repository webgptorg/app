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

`TrustMark` draws the engine fingerprint: a code and a pattern that users compare between the engine's terminal and setup page, engine-ui's security page (U-06) and the dashboard's engine list (D-06), like Signal safety numbers. It is a recognition aid; the security property stays the engine ID in the hostname.

This package never derives it. The derivation `ptbk-fingerprint-v1` and its vectors live in the open contract, `@ptbk/protocol` (`deriveEngineFingerprint`, C-11), so the open engine derives the same code; this package imports no contract package, so the apps derive and pass the result: `<TrustMark fingerprint={engineId === null ? null : deriveEngineFingerprint(engineId)} … />`, and `EngineSwitcher` takes a `fingerprint` per engine. `TrustMarkFingerprint` is the part of protocol's `EngineFingerprint` the seal reads. The gallery and tests use fixed `SAMPLE_FINGERPRINTS` copied from the vectors.

Colours are positional and not part of the fingerprint: a filled cell takes `--trust-mark-fp-N` with `N = ((row + min(column, 4 − column)) mod 6) + 1` (`fingerprintColour`).
