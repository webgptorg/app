# U-13. Fix the UX findings from the screenshot pass

- **Lane:** U · **Module:** `apps/engine-ui`, `packages/ui`, `apps/dashboard` (UI), `apps/mock-engine` (policy) · **Milestone:** M2
- **Depends on:** U-03, U-05, U-06, U-07, U-08, U-09, U-10, U-11, D-06, D-07, X-06
- **Status:** done (#108)
- **Spec:** Security hardening (members and permissions); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

The findings of a 42-screenshot pass over engine-ui and the dashboard on the local dev stack (mock engine, seeded data) are fixed, or recorded with a reason: a member sees only what the contract allows, tables fit their cards, values do not wrap mid-token, copy reads naturally in English and Czech, and empty or single-page states look designed.

## Context

The pass ran against the X-06 dev stack at 1440×900 and a 390 px phone viewport, as the owner and as a regular member. It touches several modules because the findings are cross-cutting; each fix stays inside the module that owns the problem, and shared layout problems are fixed once in `packages/ui` ([ADR 0015](../../adr/0015-ui-architecture-and-design-system.md)).

## Scope

Authorization and data (check first):

1. A member's home lists the owner's chat with the owner's private agent, and "Your agents" lists other members' private agents. Decide from the engine-api contract (C-04, C-07), the mock's policy and `docs/engine-integration/engine-api.md` whether this is a mock policy bug, an engine-ui filtering bug or intended. A security bug is fixed test first, and the conformance cross-member check is tightened if it should have caught it.
2. A secret scoped to a soft-deleted agent shows no hint that the agent is deleted; the heartbeat counts the deleted agent (8) while the list shows 7.

Layout (engine-ui, `packages/ui`):

3. The triggers table overflows its card at 1440 px.
4. Files: names break mid-word, sizes wrap, "58 byte" (plural rules in both locales), Type column truncated.
5. Audit log: IPs and the browser description break mid-token.
6. Chat at 1440×900: the composer is below the fold; markdown lists show no bullet markers.
7. Mobile chat: the agent header and tabs take half the screen and the tab bar is cut off; chat must be mobile-first.
8. Mobile drawer heading reads "Main"; the trust mark appears twice in the mobile top bar.
9. Security: the heartbeat JSON wraps mid-token.

Content and wording:

10. Run durations of days show as "610 h 3 min".
11. Run status "Completed" next to tool call "Complete"; no back link from a run to Runs.
12. Home activity lines "A run from Team member completed" read awkwardly.
13. Pagination appears with one page; "Columns" appears on tables with a handful of rows.
14. Dashboard billing shows raw plan IDs and no price; the empty engine list shows twelve column headers above the empty state.
15. Console noise: the dashboard logs an error for the expected 401 from `GET /api/session` when signed out; the engine logs a 404 for `/favicon.ico`.

## Out of scope

- The book editor's live test chat needs a design decision: [U-14](U-14-book-editor-test-chat.md).
- Trust panel rows showing "Not reported" unless the mock simply lacks data it should send.
- Oddities of the fake seed data.

## Design notes

- Formatters (durations, byte sizes with plural rules) are pure functions with unit tests in both locales.
- Pagination and column-picker visibility are decided by the `DataTable` pattern in `packages/ui`, not per screen.
- Everything stays under the engine CSP: no inline styles, Trusted Types, i18n for every string.

## Outcome

1. **Authorization bug, now fixed (#90).** An agent's `visibility` is about anonymous access through the gateway (`private` means not public), not about which members see it. The contract leaves it to the engine which chats a member may read ("every chat the member can see"), and the mock gives members `chats.read` engine-wide. So listing the owner's agents and chats to a member is intended. Writing is different: the UI shows another member's chat read-only, but any member with `chats.write` could send or cancel in it. The in-memory core now enforces this as a contract rule: only the member who started a chat writes in it, and anyone else gets 403 `forbidden` plus a `denied` audit entry. `engine-api.md` documents the rule, and the new conformance check `engine-api.cross-member.chat-writes` covers it. The existing cross-member check only tests the agent routes a target declares, so it could not have caught this. The member home now names chats with `chatName`, the same way the chat page does (title, then first message), so they no longer show as "Untitled chat". It now titles its agent list "Agents you can use".
2. **Fixed (#90).** A secret scoped to a deleted agent shows the agent's name with a "Deleted" badge and no link, because the agent's page answers 404. The heartbeat's `agents` now leaves out soft-deleted agents, like the default agent list and billing do; `heartbeat.md` defines both counts. The mock now also reports the default hostname's certificate status from the certificate it serves.

3. **Fixed (#93).** Inbound addresses wrap only after `@` and `.`, and a schedule's time zone moves to its own line, so the triggers table fits at 1440 px.
4. **Fixed (#93).** File names wrap at word boundaries. Sizes never wrap. Bytes follow each language's plural rules through `Intl` ("58 bytes", "58 bajtů"). The full MIME type shows, wrapping only after `/` or `+`.
5. **Fixed (#93).** IPv4 addresses never wrap, IPv6 addresses wrap only between groups, and user agents wrap at words.
6. **Fixed (#93).** The chat route fills the viewport under a one-line agent header, so the composer is on the first screen at 1440×900. Markdown list items show their bullets again.
7. **Fixed (#93).** At 390×844 the composer and Send are visible without scrolling. The tab bar scrolls the selected tab into view and fades the side where tabs are hidden.
8. **Fixed (#93).** The drawer is titled "Menu"/"Nabídka". The narrow top bar shows the trust mark once, and the drawer links to the trust panel.
9. **Fixed (#93).** The heartbeat JSON wraps between fields. Grouped hashes (`CodeText`) wrap between groups.
10. **Fixed (#93).** Durations longer than a day read "25 d 10 h", in both languages.
11. **Fixed (#93).** Tool calls say "Completed"/"Failed", matching run statuses. The run page has a "Back to runs" link.
12. **Fixed (#93).** Activity lines read naturally, e.g. "A run from a chat completed" and "A scheduled run started", and the agent is named on the card.
13. **Fixed (#93), in the shared `DataTable`.** Paging shows only when there is another page. The column menu shows only when a column can be hidden and the table has six or more rows, is paged, is filtered, or already hides a column. This covers the dashboard too.
14. **Fixed (#92).** Billing shows plan names in both languages, and a price when the plan configuration has one; without it, the card says Stripe shows the price before payment. With no engines, the engine list shows a designed empty state with "Link an engine" instead of the table.
15. **Fixed (#92, #93).**
    - Dashboard: the signed-out 401 from `GET /api/session` is already handled as "signed out", and a test now proves nothing logs an error. The browser's own "Failed to load resource" line is outside our code. Removing it would mean a session-optional route mode, which rule 6 does not allow, so it stays.
    - Engine: the bundle ships `favicon.svg` through the signed manifest.

- **Fixed (#108).** axe 4.14 (Dependabot #99) checks `label-content-name-mismatch`, and the avatar initial in both apps' user menus broke it: a visible "A" in front of the email or name. The new shared `Monogram` draws the initial as CSS generated content, so the initial is no longer part of the menu button's visible label.
- Also in #90: the flaky home test "shows the update banner on an engine.update-available event" matched the feed's polite live region as well as the card, depending on when the announcer flushed. The test now looks inside the list and asserts the announcement separately.

## Acceptance criteria

- [x] Finding 1 is decided with evidence from the contract; an authorization bug has a failing test first and, if the conformance suite should have caught it, a tightened cross-member check.
- [x] Each finding is fixed or recorded here with a reason, and the logic (formatters, plural rules, pagination visibility, empty states, authorization) has tests.
- [x] The fixed screens are checked visually under the engine CSP.
- [x] Local checks pass (fast policy from 2026-10-26: lint, typecheck and tests of the touched modules; `test:csp` for UI changes), recorded in each PR.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- X-04's e2e flows cover several of these screens; run them once the dev stack frees the e2e subnet.
- Whether members should read each other's chats at all is engine policy that the contract leaves open. The mock allows it. Agree on it with the engine team (E-04).
