# 0013. Book editor: CodeMirror 6 in a shadow root

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

engine-ui edits agent books (U-04): a code editor with book-language highlighting, the engine's diagnostics as markers, search, undo, and a diff of two versions. It runs under the engine's CSP ([ADR 0003](0003-ui-as-signed-bundle.md), spec "Engine security baseline", "Browser headers"): `script-src 'self'`, `style-src 'self'` (no `'unsafe-inline'`, no nonce), `worker-src 'self'`, `img-src 'self' data:`, `require-trusted-types-for 'script'` with the single policy `ptbk-html`. The predecessor used Monaco from a CDN, injected `<style>` at runtime and needed `blob:` workers; all of that is blocked here.

Candidates:

- **Monaco, bundled locally.** About 1 MB gzipped. Needs its language workers served as files (`worker-src 'self'`, no `blob:`), creates several Trusted Types policies of its own (`trusted-types` would have to list them) and inserts `<style>` elements for decorations, which `style-src 'self'` refuses.
- **CodeMirror 6.** Modular: the editor, state, language, lint, search, history and merge packages, no workers, no `innerHTML`, no `eval`. Inline styles are set through the CSSOM (`element.style.cssText`), which the CSP does not govern. Its own CSS comes from `style-mod`.

We measured `style-mod` 4.1 instead of trusting its documentation: it uses a constructable stylesheet (`adoptedStyleSheets`) **only in a shadow root**. In a document it appends a `<style>` element, and the CSP test then records three `style-src-elem` violations as soon as the editor mounts. `EditorView.cspNonce` does not help, since the engine issues no nonce.

## Decision

CodeMirror 6, mounted in a shadow root:

- Each editor or viewer (`apps/engine-ui/src/features/book/editor/`) attaches an open shadow root to its host and puts the `EditorView` inside, so `style-mod` adopts its rules as a constructable stylesheet there. Our editor stylesheet (`book-editor.css`, imported as text at build time) is adopted into the same shadow root the same way. It uses only `@ptbk/ui` custom properties, which inherit into the shadow tree, so dark mode needs no re-mount; highlighting uses `classHighlighter`'s `tok-*` classes, styled there rather than in an inline theme.
- The book language is a `StreamLanguage` tokenizer with a built-in commitment list that accepts a list from the engine once the contract offers one; diagnostics come from the engine's validation route through `@codemirror/lint`'s `setDiagnostics`, not a lint source, so the UI controls debouncing and drops stale answers. The history diff is `@codemirror/merge`'s unified view.
- CodeMirror's own rules draw small SVG backgrounds as CSS `url('data:image/svg+xml,…')` images (the lint underline, the tab marker). `img-src 'self' data:` allows them; `test/dist.test.ts` exempts exactly that CSS image shape from its no-`data:`-URL rule and nothing else.
- The editor is code-split with its two routes (`/agents/$agentId/book`, `/agents/new`); none of it is in the entry chunk. The CodeMirror chunk they share is about 105 kB gzipped.

Evidence: `test:csp` (`test/csp/book.spec.ts`) opens the book editor and the wizard's book step under the engine CSP, types a book, sees `tok-*` highlighting and an error marker, opens the diff view and records zero CSP or Trusted Types violations, with axe, 360 px overflow and layout shift checks.

## Consequences

- No worker, no Trusted Types policy, no `<style>` element and no CSP change for the editor.
- Constructable stylesheets are not governed by `style-src` in current browsers. If a browser starts enforcing it, CodeMirror would need a nonce the engine does not issue; the CSP test is the tripwire. A browser without constructable stylesheets would make `style-mod` fall back to a `<style>` element, which the CSP blocks: the editor would work, unstyled.
- Content in a shadow root is outside the page's stylesheet and outside `aria-describedby` references from the light DOM; editor styles live in `book-editor.css`, and the problems list sits next to the editor rather than being referenced from it.
- jsdom has no layout or editing model: unit tests drive the editor through CodeMirror transactions (`src/testing/book-editor.ts`), and typing with a real keyboard is covered by `test:csp`.
