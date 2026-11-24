# Agent brief: build the engine side of the Promptbook platform protocol

This file is a prompt. The engine maintainer pastes everything below the line into a coding agent that works in the engine repository. It is self-contained: it names every file the agent must read, the rules it must not break, the loop it follows and when it is done.

Before pasting, replace the two placeholders:

- `<PLATFORM_DIR>`: a read-only checkout of the repository that holds this guide and the contract packages, pinned to one commit.
- `<ENGINE_DIR>`: the engine repository (`webgptorg/promptbook`), where the agent works.

---

You are implementing the engine side of the Promptbook platform protocol in the open-source Promptbook engine at `<ENGINE_DIR>`. When you are done, the engine can replace our mock engine: it registers with the dashboard, sends signed heartbeats, keeps a tunnel to every relay, ends browser TLS itself with its own ACME certificates, puts a passkey gateway in front of everything, serves the engine API v1, and serves our signed UI bundle after verifying it. It passes the conformance suite and the platform's end-to-end tests with no change on the platform side.

## What changed

Until the contracts freeze at publication (task E-02), the platform changes them in place, without a `v2` next to `v1`, and records every change here, newest first. At the start of every session, read the entries dated after your last session and redo what they list before you continue with the plan.

Each entry has this shape. Platform authors: add yours at the top of the list, one entry per change, and keep it short; link the doc that explains the change instead of repeating it.

```md
### YYYY-MM-DD: <area>

- **Changed:** what is different in the contract, conformance or docs, with links.
- **Redo:** what the engine's agent must change, re-run or drop; "nothing" if it is inert.
```

### 2026-11-23: PRIORITY: browser onboarding on a server is broken (0.119.0-132)

- **Changed:** nothing in the contract. Seb ran the copied install command on a Hetzner Ubuntu 24.04 server with UI 0.2.4 and could not finish setup. Each item says whether a blank box hits it too. Line numbers are against `v0.119.0-132`. Fix them in this order:
  1. **Claude sign-in link is never found (blank box too).** `returnChallenge` (`claude-code/index.ts:33-44`) strips only CSI. claude 2.1.330 prints the URL inside an OSC-8 hyperlink (`\e]8;;https://claude.ai/oauth/authorize?…\a…\e]8;;\a`), so a control character follows the URL, not whitespace, and `session.ts:450` reports "The native CLI did not provide a supported authorization link" after 25 s. Strip OSC sequences (`/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g`) before matching and add a test with the real 2.1.330 output. Once this works, a server never needs the terminal: our UI already renders `harness-login` with `method: 'return-code'` (open the link, paste the code).
  2. **No API key option for Claude Code (blank box too).** The plugin has `apiKeyVariable` but no `setupApiKey`, so `session.ts:369-378` never offers "Use an API key instead". Add it (Anthropic API key, `https://console.anthropic.com/settings/keys`), with a test that the key reaches `ANTHROPIC_API_KEY`. Consider also accepting a `claude setup-token` token (it needs an auth mode that keeps `CLAUDE_CODE_OAUTH_TOKEN`).
  3. **The harness choice falls behind (blank box too).**
     - `noteActivity` (`session.ts:478-485`) never removes entries, and an aborted job returns at `:534` without updating its entry, so "Check Claude Code — running" stays after Claude Code is deselected.
     - `drive()` does nothing while an old job exists (`:528`), and its `finally` clears `this.job` without checking it is the same job (`:543-545`).
     - The final `next('harnesses', {error})` (`:611`) writes back whatever harnesses the draft holds by then. Seb's draft ended as `harnesses: ["opencode"]` with Gemini's error and no OpenCode check.
     - `returnCodeSignIn` checks `combined.aborted` only at the top of its loop, so after `await terminal.command(read)` it can still set `this.login` for a harness that was just deselected.
     - Fix: give each job an identity and let a job clear only itself; re-drive when the step is `prepare` and no job runs; have the final write check the step and harness list it started with; reset activity on a new answer. Add a test that answers, changes the answer mid-check and deselects.
  4. **A failed check hides the sign-in (Gemini here).** `gemini/index.ts:37` treats `selectedType: "gemini-api-key"` in `~/.gemini/settings.json` as signed in even for a NATIVE check, whose environment blanks `GEMINI_API_KEY`. `session.ts:573` then skips the sign-in prompt and fails at `:591` with "the engine could not verify a real response". A NATIVE check must not count an API-type selection. On any failed check, show the CLI's own diagnostic and fall through to the sign-in/API key prompt instead of a dead end.
  5. **Provider sign-in expires and there is no way back (blank box too).**
     - Without `accountProfile`, every project of one OS user shares `~/.claude` (`harnesses.ts:74`). Concurrent `claude` processes then race on refresh-token rotation. Seb's project failed 3 minutes after signing in with "OAuth session expired and could not be refreshed".
     - Give each project its own `CLAUDE_CONFIG_DIR`, or serialize refreshes.
     - After setup there is no browser path to sign in again: the harness terminal is mounted only while initialization is pending (`onboarding-page.ts:10`). Our UI already shows the setup notice and the `harness-login` form whenever onboarding is `pending`, so the quickest path is to reopen onboarding with a `harness-login` step when a provider sign-in expires. Otherwise, tell us and we add a problem code or capability for "this AI tool needs signing in again". Until then, the chat error must name `ptbk tool enable <name>`. **Superseded by the 2026-11-24 entry: build `ai-tools@1` instead of reopening onboarding.**
  6. **The terminal page asks "This link could potentially be dangerous" (blank box too).** `harness-terminal-browser.ts:40` creates the xterm `Terminal` without a `linkHandler`, so xterm 6 falls back to its `confirm()`. Pass a `linkHandler` that opens `https:` links with `window.open(uri, '_blank', 'noopener,noreferrer')`.
  7. **Wallet on a fresh Ubuntu 24.04 as non-root.** `host-unlock.ts:116-139` fails: systemd 255 has no `--user` for `systemd-creds`, and the host secret is root-only with no TPM. Setup continues without the Wallet (`wallet.ts:999-1003`), so this isn't fatal, but most VPSes look like this. Fall back to a key file sealed under the engine user, or say clearly what is lost.
  8. **Stopping takes 90 s and ends in SIGKILL.** `ServiceHost.shutdown` (`host.ts:553-586`) runs about 12 steps, each allowed 10 s, and `cli.ts:47` only sets `process.exitCode`. Add an overall shutdown deadline and exit after a foreground shutdown.
- **Platform side (ours, in progress):** the install script reuses only a `ptbk` from its own prefix (Seb's run picked up an unrelated wrapper on `PATH`), enables linger so a user unit survives reboots, and shrinks to one line. The UI fixes a stale selection in the choice form and gives the setup screens a step timeline.
- **Redo:** items 1 to 6, then 8. Item 7 when you can. Publish, and tell us the version so we can repeat the run on a blank Hetzner box.

### 2026-11-24: AI tools management (ai-tools@1)

- **Why:** after setup there is no browser path to see or fix the AI tools a project runs on. When a Claude sign-in expires (item 5 of the 2026-11-23 PRIORITY entry), a project on a server is dead until someone SSHes in. Owners who never use a terminal must be able to do all of it from the browser.
- **Supersedes** the "reopen onboarding with a `harness-login` step" stopgap of 2026-11-23 item 5. Do not build that; build this. Items 1, 2 and 5 of that entry (the OSC-8 link, `setupApiKey`, one `CLAUDE_CONFIG_DIR` per project) are still needed: this capability drives the same code.
- **Changed** ([ai-tools.md](ai-tools.md), [engine-api.md, AI tools](engine-api.md#ai-tools), [ai-tools.ts](../../packages/engine-api/src/capabilities/ai-tools.ts)):
  - `KNOWN_CAPABILITIES.aiTools` (`ai-tools@1`) and permissions `ai-tools.read` (who oversees the project: owners and admins) and `ai-tools.manage` (owners only, like `browser.control`).
  - `GET /ai-tools`, `GET /ai-tools/{aiToolId}`, `POST /ai-tools/{aiToolId}/check` (202, `checking` until the call ends).
  - `POST /ai-tools/{aiToolId}/sign-ins` (step-up) with `{ method: 'account' | 'api-key' }`, then `GET`, `POST …/answer` and `DELETE /ai-tools/{aiToolId}/sign-ins/{signInId}`. The prompts and answers are onboarding's `harness-login` and `secret` ones, unchanged; `canGoBack` is `false`.
  - `DELETE /ai-tools/{aiToolId}/credentials` (step-up): sign out.
  - Event `ai-tool.changed { aiToolId }`; problems `ai-tool-not-installed` (409), `ai-tool-sign-in-stale` (409), `ai-tool-method-unsupported` (422) and `ai-tool-sign-in-required` (503, extension `aiToolId`); `ChatRecheck.aiToolId`; audit actions `ai-tool.sign-in.start`, `ai-tool.sign-in.complete`, `ai-tool.sign-out` on target kind `ai-tool`.
  - Conformance `engine-api.ai-tools.check`, `.permissions`, `.sign-in-flow`, `.secret-never-echoed` and `.sign-in-required` (the last needs the test-mode levers `ConformanceTarget.aiTools`: expire and renew the sign-in of the tool chats run on). Checklist ENG-126 and ENG-127.
  - The UI ships it in the next release: Settings › AI tools, "Sign in again" on a failed chat reply, a line on Home while a tool needs signing in.
- **Version:** `ENGINE_API_VERSION` stays 1.15.0. Everything here is additive: the capability is off until you advertise it, and `ChatRecheck.aiToolId` defaults to `null`, so an engine that has not re-vendored keeps working with the next UI release.
- **Redo:** re-vendor the contract. Then, after items 1 to 6 of the 2026-11-23 entry:
  1. **Map your harnesses to tools.** One `AiTool` per harness the project knows, in the order agents prefer them; installed ones from your harness registry, the rest `not-installed` with `signInMethods: []`. IDs as proposed in [ai-tools.md, Open](ai-tools.md#open-for-the-engine-team): `claude-code`, `codex`, `gemini-cli`, `opencode`. `auth.account` from what the CLI reports (`claude auth status`, `~/.codex/auth.json`'s plan); never the key, never a token.
  2. **Status from a real call.** Keep the outcome of each harness check (the same check setup runs in `session.ts`) per project: `checkedAt`, and on failure a `problem` whose `code` you map from the CLI's error (an expired or refused OAuth session is `sign-in-expired`, a refused key `key-rejected`, a quota or billing error `quota-exceeded`, a network or 5xx `provider-unavailable`, else `check-failed`) and whose `message` is the CLI's own diagnostic, with ANSI and OSC sequences stripped and secrets redacted. Run a check in the background on `POST …/check` and when a harness call fails in real work; send `ai-tool.changed` on every change.
  3. **Sign-in by account** reuses the onboarding sign-in session: `returnCodeSignIn` (Claude Code, `return-code`) and the device login (Codex, `device-code`) in `session.ts`, now callable outside initialization and per project. Write the new credentials into the project's own profile (`accountProfile`, `CLAUDE_CONFIG_DIR` from 2026-11-23 item 5, `harnesses.ts:74`), not the OS user's shared one, and switch over only after the verifying call answers. The harness terminal page (`onboarding-page.ts:10`) is not needed for this.
  4. **Sign-in by API key** reuses `setupApiKey` (2026-11-23 item 2) and the Wallet's secret store (`wallet.ts`): verify the key with one real call, then store it for the project and point the harness at it (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` through the harness's `apiKeyVariable`). Refusals are a fixed text plus the provider's reason, never the key.
  5. **Chat turns.** When a turn cannot start or fails because its harness needs a sign-in, end it with a recheck carrying `aiToolId` (or a reply stream `failed` with `ai-tool-sign-in-required` and `aiToolId`). Do not keep rechecking while the tool still needs signing in; once it is signed in again, run the waiting recheck. Replace the "run `ptbk tool enable <name>`" chat error of 2026-11-23 item 5 with this.
  6. **Test-mode levers** in your conformance target module: `aiTools.expireSignIn()` (make the provider refuse the sign-in of the tool chats run on, e.g. by corrupting the test profile's token; answer its ID) and `aiTools.renewSignIn(id)`.
  7. Advertise `ai-tools@1` once AT-01 to AT-14 pass, then run the `engine-api.ai-tools.*` checks and AT-15 and AT-16.
- **Test cases** (AT-01 to AT-14 unit-level in the engine, AT-15 and AT-16 on a real server):
  - **AT-01** `GET /ai-tools` lists every known harness once, in preference order; one not on the host is `not-installed` with `signInMethods: []`, `auth: null` and problem `not-installed`.
  - **AT-02** A tool has `problem` exactly when it is not `signed-in`; the response never contains a key, token, refresh token or login code (search the serialized JSON for the test key and token).
  - **AT-03** `POST /ai-tools/{id}/check` answers 202; while the call runs `checking` is `true`; when it ends `checkedAt` moved, `checking` is `false`, the status matches the outcome, and one `ai-tool.changed` was sent. A second check while one runs starts no second call. A `not-installed` tool is 409 `ai-tool-not-installed`.
  - **AT-04** A Claude session whose refresh failed ("OAuth session expired and could not be refreshed") reads `needs-sign-in` with `sign-in-expired` and the CLI's message, ANSI and OSC stripped.
  - **AT-05** Without `ai-tools.read`: 403 on list, get and check. With it but without `ai-tools.manage`: 403 `forbidden` naming `ai-tools.manage` on start and sign-out, audited `denied`, nothing changed. A member never gets `ai-tool.changed` without `ai-tools.read`.
  - **AT-06** Start and sign-out without a fresh step-up are 401 `step-up-required`; the answer, read and cancel routes need none.
  - **AT-07** Starting an `account` sign-in for Claude Code answers 201 with a `harness-login` prompt, `method: 'return-code'`, the claude.ai URL from the OSC-8 link (2026-11-23 item 1), `canGoBack: false`, and the alternative `api-key`. For Codex it is `device-code` with `userCode`, and the sign-in completes by itself once the provider confirms.
  - **AT-08** A pasted code the CLI refuses comes back as a new prompt (new `id`) with `error` or `status: 'failed'` and the CLI's diagnostic; retry (`returnCode: null`) starts a new login. The tool's old credentials keep working throughout.
  - **AT-09** A correct code: `status` goes `working` then `completed`; the credentials are written to the project's own profile only, a real call answered before the switch, the tool reads `signed-in`, audit has `ai-tool.sign-in.complete` with `details: { method: 'account' }` and no code.
  - **AT-10** `api-key`: a key the provider refuses comes back as a new `secret` prompt with a fixed error plus the provider's reason; no file, log line, audit entry, heartbeat, chat or error contains the key. A valid key completes, `auth` reads `{ method: 'api-key', account: null }`, and the harness uses the key from the store.
  - **AT-11** An answer with a `promptId` that is not current is 409 `ai-tool-sign-in-stale` and changes nothing; an answer of the other kind, or an alternative the prompt does not offer, is 400 `validation-failed`.
  - **AT-12** Another gateway session, the same owner's included, gets 404 for the sign-in on read, answer and cancel. Starting a second sign-in for the tool ends the first (404 afterwards). An unfinished sign-in is forgotten at `expiresAt`.
  - **AT-13** `DELETE /ai-tools/{id}/credentials` removes the project's sign-in or key (not another project's), reads `needs-sign-in` with `not-signed-in`, is idempotent and audited `ai-tool.sign-out`.
  - **AT-14** Two projects of one OS user: signing one in or out does not change the other (each its own profile), and concurrent turns in both no longer race on token refresh.
  - **AT-15** On a Hetzner box: expire the Claude sign-in, send a chat message; the turn fails with `recheck.aiToolId: 'claude-code'`, the UI's "Sign in again" completes the sign-in in the browser, and the waiting recheck answers. No SSH involved.
  - **AT-16** Same box: switch Claude Code to an API key from Settings › AI tools, then back to the account, with the chat working after each switch.

### 2026-11-23: Live browser: permission loss, help message, more checks

- **Changed** ([live-sessions.md](live-sessions.md#a-session-belongs-to-its-gateway-session), in place in `browser-tab@1`):
  - A browser session ends with `revoked` as soon as its member no longer holds what it needs: `browser.watch` with sight of the tab's work, and `browser.control` while controlling. A role change counts, without waiting for the member's next request.
  - The channel upgrade needs `browser.watch` (403 before the session is looked up). `browser.control` alone no longer attaches.
  - The attach is audited once the WebSocket handshake completed; a failed handshake is `failed`.
  - `BrowserHelpRequest.message` refuses control characters (line breaks and tabs included) and bidi embeddings, overrides and isolates. `toBrowserHelpMessage` folds model output into an accepted line.
  - New checks: `engine-api.browser-tab.permissions` (403 on every browser route and the channel), `engine-api.browser-tab.origin-refused`, `engine-api.browser-tab.revoked`, `engine-api.browser-tab.watcher-blocked`.
- **Redo:** require `browser.watch` on the channel upgrade, end sessions on permission loss and audit the real attach outcome (LB-03, LB-08, LB-14 and LB-15 changed), pass the message through `toBrowserHelpMessage` or the same rule, then re-run the `engine-api.browser-tab.*` checks.

### 2026-11-23: Gateway pages print complete `ptbk` commands; local-stack findings

- **Changed:**
  - **Gateway pages:** the recovery hints on setup, sign-in and step-up now render whole commands (#353, [gateway-pages README](../../packages/gateway-pages/README.md)). New values `{{setupLinkCommand}}`, `{{resetOwnerCommand}}` and `{{statusCommand}}`. For `command: 'ptbk'` they default to `ptbk connect --setup-link`, `ptbk connect --reset-owner` and `ptbk status`.
  - **Local stack:** the platform's local stack can now run your conformance build (#342, [testing-against-the-platform.md](testing-against-the-platform.md)). Running it turned up the items under "Worth fixing".
- **Redo:**
  - Re-vendor `setup.html`, `sign-in.html`, `step-up.html` **and** `render-page.ts`. While initialization is pending, pass `setupLinkCommand: 'ptbk connect --onboarding <engine-id> --setup-link'`, `resetOwnerCommand: 'ptbk connect --onboarding <engine-id> --reset-owner'` and `statusCommand: 'ptbk onboarding --id <engine-id> --json'`. Installed engines only see the new hints after a release.
  - Worth fixing, none blocking:
    1. The conformance build's daemons start the release build (`engineModule()` resolves `<root>/dist`); our image has to install `dist-conformance/` as `dist/`. Consider starting the build that launched them.
    2. A pending engine (`init --prepare-only`) runs only as a detached background service. A foreground mode would fit containers better.
    3. `--json` prints JSON over several lines, which is unusual for machine output. Consider one compact line per result.

### 2026-11-20: PRIORITY: our UI out of the box, with a staging build of `ptbk`

- **Goal:** the owner types two things into a terminal, and that is the last time they use it:
  1. `npm install --global ptbk@<version>`.
  2. The `ptbk init --prepare-only --link …` command shown on app.ptbk.io → Engines → New engine.

  From there:
  - **Paired at once.** The engine pairs immediately, before it is initialized. The terminal asks nothing more and only prints the setup link.
  - **Setup in the browser.** The owner opens the engine and finishes setup in our signed UI on the engine's origin, end to end encrypted through the relay: the brief, the AI tools and their sign-in, the project and its folder. The terminal is offered only as a fallback link.
  - **Controlled from the web.** Afterwards everything runs in that UI, and the engine keeps running as a service across reboots.
  - **No configuration.** No setting or `PTBK_*` variable is needed anywhere.

  The work comes in this order:
  1. This entry: the engine serves our UI with no configuration.
  2. The 2026-11-19 entry: setup in the browser.
  3. Then the platform releases engine-ui 0.2.4 with the setup screens, and together we run STG-20 to STG-24 on a clean machine.

- **Changed:** Decided 2026-11-20, described in [ui-loader.md, Staging builds](ui-loader.md#staging-builds), until the key ceremony:
  - The published `ptbk` is a staging build. Its build profile is fixed at build time and never read at runtime.
  - It embeds the platform's staging trust policy and the staging defaults (`https://ui.ptbk.link/`, `engines.ptbk.link`).
  - For the trust policy it is not production, whatever `NODE_ENV` says. Like a production build, it refuses `PTBK_CONFORMANCE_TRUST_FILE`.
  - `ptbk init --prepare-only --link` approves the first UI bundle by hand, so our UI is the first page without the 5-minute wait.
  - New checklist item ENG-121, with test cases STG-01 to STG-24. ENG-59, ENG-116, [installation.md, Configuration](installation.md#configuration) and [staging.md, Settings](staging.md#settings) follow.
- **Redo:**
  - **Do this first, before the 2026-11-19 entry.** Without it, an engine installed with `npm install` and one command serves only the plain engine page, so the owner never reaches setup in the browser.
  - Add the build-time profile. Embed `trust-policy.staging.json` from a pinned platform commit, check its SHA-256 at build, and default the release URL and engine domain in staging builds. Publish the npm package as a staging build.
  - Let the profile, not `NODE_ENV`, decide the trust policy in a staging build. The installed service keeps `NODE_ENV=production`, and production builds keep refusing staging policies.
  - Treat `ptbk init --prepare-only --link` as the installer for the first bundle: `mode: 'manual'` for that bundle only, with every other check.
  - Write the engine tests STG-01 to STG-14, then run STG-20 to STG-24 on a clean machine. Done when a clean install from the block on app.ptbk.io passes `ptbk-conformance staging` with no `PTBK_*` variable set anywhere.

### 2026-11-20: Voice phase 1: push-to-talk and spoken replies (lower priority)

- **Priority:** lower than every other open entry. Finish the staging build (2026-11-20, PRIORITY), setup in the browser (2026-11-19) and the live browser (2026-11-20) first. Nothing breaks if you skip this: no UI uses it yet, and an engine that advertises neither capability passes conformance as before.
- **Goal:** a member speaks to an agent and hears it answer, in the chat, with the speech work done by your harness or its provider and never by our services. Two capabilities, each on its own:
  - `voice-input@1`, push-to-talk: the browser records up to a minute, you transcribe it, and the UI puts the text into the composer for the member to edit and send as an ordinary message.
  - `voice-output@1`, spoken replies: you read one chat message aloud in a format the browser can play.
- **Changed:** [voice.md](voice.md), [engine-api.md, Voice](engine-api.md#voice), [voice.ts](../../packages/engine-api/src/capabilities/voice.ts):
  - `KNOWN_CAPABILITIES.voiceInput` and `voiceOutput`.
  - `POST /chats/{chatId}/transcriptions` (`transcribeVoiceClip`, `chats.write`): a **raw binary body**, the first in the API (`RouteBody` kind `binary`). Its `Content-Type` is one of `VOICE_CLIP_FORMATS` after `normalizeMediaType`; at most `MAX_VOICE_CLIP_BYTES` (2 MiB) and `MAX_VOICE_CLIP_MS` (60 s); optional `?language=`. Answers 200 `TranscriptDraft { text, language, confidence, durationMs }`. It adds nothing to the chat.
  - `POST /chats/{chatId}/messages/{messageId}/speech` (`speakChatMessage`, `chats.read`): body `{ formats }` from `SPEECH_FORMATS`, answers the audio in the first one you can make (a typed binary response) or 415.
  - Problem codes `voice-clip-too-long` (422), `transcription-failed` (502), `speech-too-long` (422), `message-not-speakable` (409), `speech-failed` (502), `voice-unavailable` (503).
  - `Permissions-Policy` sends `microphone=(self)` while `voice-input@1` is advertised ([gateway.md](gateway.md#security-headers)).
  - Conformance: `engine-api.voice.transcription-caps`, `engine-api.voice.transcription-draft`, `engine-api.voice.speech`, `engine-api.voice.permissions` (skip without the capability) and `engine-api.voice.permissions-policy` (runs on every engine with a gateway, so it checks `microphone=()` today). Checklist ENG-123 to ENG-125.
  - Phase 2, full-duplex over the live channel, is designed in [live-sessions.md](live-sessions.md#live-audio-phase-2) only; `live-audio@1` stays reserved.
- **Redo:**
  1. Now, whatever your priority: re-vendor the contract and keep `Permissions-Policy` at `microphone=()`; `engine-api.voice.permissions-policy` checks it on your engine today.
  2. Tell us what your harnesses can do (questions below) before building.
  3. When you build it: serve both routes from the route table, with the raw body read under its cap before anything else, the clip decoded to measure its length, handed to the provider and dropped. Advertise each capability only when a provider for it is configured; answer 503 `voice-unavailable` when it cannot serve right now. Switch `microphone=(self)` with `voice-input@1`. Write VO-01 to VO-12, run the voice conformance checks, then VO-13 and VO-14 by hand.
- **Test cases** (VO-01 to VO-12 unit-level in the engine, VO-13 and VO-14 by hand):
  - **VO-01** Each of `audio/webm;codecs=opus`, `audio/ogg; codecs="opus"` (Firefox's spelling) and `audio/wav` is accepted; `audio/mpeg`, `text/plain`, a missing `Content-Type` and `audio/webm` without codecs are 415, before the body is read.
  - **VO-02** A `Content-Length` over 2 MiB is 413 without reading the body; a chunked body that passes 2 MiB is cut off at the cap with 413.
  - **VO-03** The duration comes from decoding, not a header: a `MediaRecorder` WebM with no `Duration` element gives the right `durationMs`; a 61 s WAV under 2 MiB is 422 `voice-clip-too-long`, and the provider is never called for it.
  - **VO-04** An undecodable clip (random bytes typed `audio/ogg;codecs=opus`) is 502 `transcription-failed` with a generic `detail`.
  - **VO-05** After a transcription, successful or not, no file in the data directory, temp directory or cache holds the clip, and no log line or audit entry contains the audio, its base64 or the transcript text.
  - **VO-06** A transcription adds no chat entry, emits no `chat.changed` and starts no turn; sending the draft afterwards is an ordinary message with the member as author.
  - **VO-07** Silence gives 200 with `text: ""`; `language` is the asked one or the detected one or `null`; `confidence` within 0 to 1 or `null`.
  - **VO-08** With the harness signed out or the provider down, both routes answer 503 `voice-unavailable` while `GET /engine` still advertises the capability; with no provider configured at all, neither capability is advertised and the routes answer 404 `capability-not-supported`.
  - **VO-09** Speech: `{ formats: ['audio/mpeg'] }` is 200 `audio/mpeg` (or 415 if you cannot make MP3); the answer's type is always the first offered format you can make; none of them is 415; `Cache-Control: no-store`, `nosniff`, attachment.
  - **VO-10** Speech of a streaming, failed, cancelled or empty message is 409 `message-not-speakable`; of a message over 4,000 UTF-16 code units 422 `speech-too-long`, without calling the provider.
  - **VO-11** A member without `chats.write` gets 403 on transcriptions, without `chats.read` 403 on speech; a chat or message they cannot see, or a message of another chat, is 404.
  - **VO-12** `Permissions-Policy` has `microphone=()` on every response while `voice-input@1` is not advertised, `microphone=(self)` on every response (API, UI files, gateway pages, errors) while it is, and the rest of the header unchanged.
  - **VO-13** By hand in Safari: record through the UI's WAV fallback (or upload a 16 kHz mono PCM16 WAV with curl) and get a draft in the composer.
  - **VO-14** By hand in Chrome and Firefox: a real recording of a sentence gives a sensible draft in the spoken language; a reply read aloud plays.
- **Questions for you** (answer in [voice.md, Open for the engine team](voice.md#open-for-the-engine-team)):
  1. What can each harness do for speech-to-text and text-to-speech: Codex with a ChatGPT login, Claude Code, an OpenAI or other API key, a local model?
  2. Which formats do they take and return, and where would you transcode?
  3. Which languages, and do they detect the language themselves?
  4. Which per-member and per-engine limits fit the cost?

### 2026-11-19: Setup in the browser after pairing: new input kinds

- **Changed:** `onboarding@1` gains what the App flow needs so the owner never goes back to the terminal after pairing ([engine-api.md, Onboarding](engine-api.md#onboarding), [onboarding.ts](../../packages/engine-api/src/capabilities/onboarding.ts)). The prompt kinds are now a fixed vocabulary the UI ships first; you compose and reorder steps from them freely. New: a `secret` prompt kind and answer (API keys; never presented back, logged or kept in the draft); `details` and `alternatives` on every prompt, with `{ action: alternative, alternativeId }` (an alternative with `href` is a same-origin link the UI opens, not an answer); `activity` on the state (each install or check `running`, `done`, `failed` with its reason, or `skipped`); `canDefer` with problem `onboarding-not-deferrable`. The heartbeat gains optional `setup: pending | done` ([heartbeat.md](heartbeat.md)). The platform's signed UI renders setup on a pending engine; it reads unknown prompt kinds as unsupported and points at `ptbk onboarding`.
- **Redo:**
  - Serve the approved signed UI while initialization is pending, with the passkey gateway in front as for any engine; keep the built-in onboarding page only for when no approved bundle is available. A pending engine advertises `onboarding@1` and `files@1` and may leave out every other capability.
  - Send `canDefer: false` until the project exists, and `setup: pending` in every heartbeat from pairing until setup completes.
  - Move the API-key path into the contract. On the sign-in step, offer "Use an API key instead" as an alternative without `href`, then present a `secret` prompt (`helpUrl` = the provider's key page). Verify the key with a real call and refuse it with `error` on the same kind of prompt. Drop the `api-key` action from `/_ptbk/harness-terminal`.
  - Keep the native terminal as a fallback: an alternative with `href: "/_ptbk/harness-terminal"`, next to a `confirm` "Check sign-in". Prefer `return-code` for Claude Code (paste the code back) and `device-code` for Codex and Copilot, so the terminal is the exception.
  - Report the harness installs and real checks as `activity` while `working`, and keep failed additional harnesses in it on the next prompt. Put the final summary (project, folder, harnesses) in the review prompt's `details`.
  - Fill the new fields with defaults where there is nothing to say: `details: []`, `alternatives: []`, `activity: []`, `canDefer: true`. Re-run the onboarding conformance checks.

### 2026-11-20: Live browser: contract ready

**Lower priority than the 2026-11-20 PRIORITY entry and the 2026-11-19 setup entry. Finish both first.** Nothing here is rolled out: keep `browser-tab@1` unadvertised by default.

- **Goal:** a member watches the tab an agent works in, live, from our UI on the engine's origin; the owner takes it over with one click and a passkey when the agent is stuck (a captcha, a login, a confirmation), then hands it back and the agent carries on; the owner can also open a fresh tab to sign in to a site by hand. Frames and input stay inside the engine's TLS: no relay, tunnel or CSP change.
- **Changed:** `browser-tab@1` moves from reserved to a known draft capability ([live-sessions.md](live-sessions.md), [ADR 0019](../adr/0019-live-sessions-inside-the-tunnel.md) Accepted with revisions):
  - Routes ([live.ts](../../packages/engine-api/src/capabilities/live.ts)): `POST /browser-sessions` (sign-in tab; replaces the reserved `POST /browser-tab-sessions`), `GET /browser-tabs`, `POST /browser-tabs/{tabId}/watch` and `/control`, `GET /browser-sessions/{sessionId}`, `POST /browser-sessions/{sessionId}/control`, `/hand-back`, `/end`, `GET /browser-help-requests` and `/{requestId}`, `POST /browser-help-requests/{requestId}/dismiss`. Events `browser-tab.changed` and `browser-help.changed`.
  - New permission `browser.watch`, beside the owner-only `browser.control`. Step-up on opening a sign-in tab and on taking control. New problem codes `browser-tab-controlled`, `browser-tab-full`, `browser-busy`, `browser-session-ended`, `browser-help-resolved`, `live-channel-attached` (409) and `browser-origin-refused` (422). New audit actions `browser.*` and targets `browser-session`, `browser-help-request`.
  - The channel format is fixed ([live-channel.ts](../../packages/engine-api/src/capabilities/live-channel.ts)): `hello`, `view`, `frame-ack`, `input`, `end` in; `hello`, `state`, `navigated`, `blocked`, `input-refused`, `end` out; a closed set of pointer, wheel and key events; media as a 13-byte header plus one image, 64 KiB at most.
  - Reference behaviour: the in-memory engine ([in-memory/live.ts](../../packages/engine-api/src/in-memory/live.ts) and its tests). Conformance: the `engine-api.browser-tab.*` checks replace "must not be advertised" for this capability; `live-audio@1` and `live-video@1` stay reserved.
- **Redo:**
  1. Keep it off: advertise `browser-tab@1` only when an engine setting or test mode turns it on, and only while the browser tool runs. Everything else stays as it is until the platform asks to roll out.
  2. Serve the routes through your route table with their permissions and step-up, and the WebSocket at `/api/v1/live-sessions/{sessionId}/channel` behind the gateway: session cookie, `Origin` equal to the engine's own origin, subprotocol `ptbk-live`, nothing in the URL.
  3. Frames: CDP `Page.startScreencast` on the one tab (format JPEG, `maxWidth`/`maxHeight` from the viewer's `view`, a quality that keeps each frame under 64 KiB with the header), each `Page.screencastFrame` sent as `encodeLiveMedia({ kind: 'tab-frame-jpeg', … })`, `Page.screencastFrameAck` only once the viewer's `frame-ack` frees credit (at most 2 unacknowledged). `Page.stopScreencast` while the view is hidden or the page is blocked.
  4. Input: replay each `LiveInputEvent` with `Input.dispatchMouseEvent` (pointer and wheel) and `Input.dispatchKeyEvent` (named keys as `key`/`code`, a character with `text`), modifiers Shift only. Nothing else from the client reaches CDP. While a human controls a tab, cancel file choosers (`Page.setInterceptFileChooserDialog`) and deny downloads (`Browser.setDownloadBehavior`).
  5. Blocking: watch `Page.frameNavigated` and the target's URL; send `navigated { origin }` or `blocked { reason }` and stop frames and input on `chrome://`, `about:`, `devtools:`, extension, `file:` and `view-source:` pages, the password manager and settings, the Wallet's protected entry, and, while a human controls the tab, any origin outside the tab's origin at takeover plus the sign-in allowlist.
  6. Pause and resume: taking control marks the agent's tab paused; the agent's browser tool waits at its next action instead of acting (the run keeps running, nothing is cancelled). When control ends (hand back, end, expiry, idle, revocation, protocol error) the tool resumes and gets the outcome `{ outcome, origin }` as a tool result: `handed-back`, `ended`, `expired`, `idle`, `blocked-origin` (control ended on a page the session could not show), `revoked`, or `cancelled`.
  7. Help requests: let the agent's browser tool raise one (reason `login`, `captcha`, `confirmation`, `blocked` or `other`, and a short message of at most 500 characters), one open per tab, and wait for its resolution as above; `dismissed` when the owner declines.
  8. Limits: one controller per tab, 5 sessions per tab, one sign-in session per engine, `endsAt` 10 minutes after opening, `attachBy` 30 s, 2 minutes without input ends a controller's session, more than 120 input events a second is a protocol error. A session is bound to the gateway session that opened it; revoking that session or the member ends it.
  9. Audit metadata only (session, origin, outcome, reason, duration). Never log frames, input or typed text.
  10. Write the engine tests LB-01 to LB-17, then run LB-20 to LB-25 by hand. Done when the `engine-api.browser-tab.*` checks pass against your engine in test mode and the by-hand cases pass on a headless VPS.
- **Test cases (engine, unit level):**
  - LB-01 Without the setting, `GET /engine` lacks `browser-tab@1` and every route answers 404 `capability-not-supported`.
  - LB-02 A session opened by one gateway session is 404 to every other one, the same member's included, on every route and on the channel.
  - LB-03 The channel upgrade without a cookie is 401, with another `Origin` or without `browser.watch` 403, without `ptbk-live` refused, a second attach 409 `live-channel-attached`; after a drop the same gateway session attaches again. A handshake that fails after the engine accepted the upgrade is audited as `failed`.
  - LB-04 `POST /browser-sessions`, `POST /browser-tabs/{id}/control` and `POST /browser-sessions/{id}/control` answer 401 `step-up-required` without a fresh assertion, 403 without `browser.control`.
  - LB-05 A watcher's `input` is answered `input-refused { reason: 'not-controlling' }` and nothing reaches `Input.dispatch*`.
  - LB-06 A second controller gets 409 `browser-tab-controlled`; watchers keep their frames.
  - LB-07 Taking control pauses the agent's browser tool at its next action; handing back resumes it with `handed-back`.
  - LB-08 On a `chrome://` page, the password manager and the Wallet's entry page, no frame is forwarded to anyone, watchers included, input is refused `blocked`, and `blocked` carries no origin. A watcher follows the agent to any web origin, but while someone controls the tab gets no frame off the controller's origins.
  - LB-09 A sign-in at an origin outside the allowlist or at the engine's own origin is 422 `browser-origin-refused`; while controlled, a link to another origin stops frames until the tab returns.
  - LB-10 Every `LiveInputEvent` maps to one `Input.dispatchMouseEvent` or `Input.dispatchKeyEvent` with Shift as the only modifier; file choosers and downloads are refused while controlled.
  - LB-11 An unknown message, a message over 4 KiB, a binary message from the browser, or anything before `hello` ends the channel with `end { reason: 'protocol-error' }` and close 1008.
  - LB-12 Every media message decodes with `decodeLiveMedia`, is at most 64 KiB, and no third frame is sent before an ack.
  - LB-13 With a fake clock: no attach in 30 s, after opening or after a drop, ends with `not-attached` (a controlled tab goes back to the agent), `endsAt` with `expired`, 2 minutes without a controller's input with `idle`; watchers are not idle-ended.
  - LB-14 Revoking the gateway session, removing the member, or a policy or role change that takes `browser.watch` (or sight of the tab's work) ends their sessions with `revoked`; one that takes `browser.control` ends a controller's session, and its help request resolves `revoked`. Without waiting for the member's next request.
  - LB-15 A help request goes `pending` (tab `waiting`), `in-progress` on control, `resolved` with `handed-back`, `dismissed`, `blocked-origin` or `cancelled` (the agent's work closed the tab); its `message` is stored as one line of plain text: the model's line breaks, tabs, control characters and bidi controls folded away (`toBrowserHelpMessage`).
  - LB-16 After a session in which `hunter2` was typed, the audit log holds the `browser.*` entries and neither the typed text nor a URL path.
  - LB-17 `browser-tab.changed` and `browser-help.changed` go out, IDs only, to members with `browser.watch` only.
- **Test cases (by hand, on a headless VPS engine with the setting on):**
  - LB-20 An agent task browses a site; a member watches it from the engine UI and sees it move; the relay's packet capture shows only TLS.
  - LB-21 The agent hits a captcha and raises a help request; the owner gets it in the UI, takes control in one click with a passkey, solves it, hands back, and the agent carries on and mentions the outcome.
  - LB-22 The owner opens a sign-in tab at a Wallet login's origin, signs in, ends it; the agent's next task is signed in.
  - LB-23 During control, opening the browser's settings or the Wallet's entry stops the frames until the tab leaves it.
  - LB-24 Leaving a controlled tab alone for 2 minutes ends the session as `idle` and the agent resumes.
  - LB-25 `ptbk-conformance` runs the `engine-api.browser-tab.*` checks with the engine's test-mode levers ([conformance.md](conformance.md#writing-a-target)) and none fails.

### 2026-11-18: Sign-in shows ways forward without a passkey

- **Changed:** [`sign-in.html`, `gateway.js` and `gateway.css`](../../packages/gateway-pages/pages/) in `@ptbk/gateway-pages`. Under the sign-in button, and after a cancelled, failed or unrecognised passkey, the page says what to do without a passkey for this engine on this device: use the phone option in the browser's prompt, use a synced passkey or the device that has it, or open the engine from the Promptbook dashboard to join. The copy sits once after the sections in an element with `data-shown-in="<states>"`, which `gateway.js` shows only in those states. The button still opens the prompt only on a click. Endpoints, placeholders and CSP are unchanged ([gateway.md, Sessions](gateway.md#sessions)).
- **Redo:** copy `sign-in.html`, `gateway.js` and `gateway.css` from `packages/gateway-pages/pages/` again. Nothing changes on the server.

### 2026-11-17: Step-up confirmed in a popup, then the action goes on

- **Changed:** [`step-up.html` and `gateway.js`](../../packages/gateway-pages/pages/) in `@ptbk/gateway-pages` support `mode=popup`. The engine UI opens `STEP_UP_PATH?mode=popup&nonce=<16–64 base64url characters>&returnTo=…` in a small window. The page starts the passkey prompt at once and, after verify succeeds, posts `{ type: 'step-up-confirmed', nonce }` on `BroadcastChannel('ptbk-step-up')` and to `window.opener` (same origin), then closes itself. The UI sends the original request again with the input still in memory (a Wallet password included). If the popup is blocked, the UI falls back to the full-page redirect as before ([gateway.md, Step-up](gateway.md#step-up)).
- **Redo:**
  1. Copy `step-up.html` and `gateway.js` from `packages/gateway-pages/pages/` again.
  2. Make the step-up page accept `mode=popup` and `nonce` in its query next to `returnTo`; if your gateway parses page queries strictly, it must not refuse them.
  3. Nothing else changes on the server: options and verify answer as before, and a popup step-up confirms the same session.

### 2026-11-16: Smoother join: waiting page signs in, tries left, UI invites in the dashboard

- **Changed:**
  - [`join.html`, `gateway.js` and `gateway.css`](../../packages/gateway-pages/pages/) in `@ptbk/gateway-pages`. The join page explains the second passkey in one line. The waiting page shows the code large ("482 913") with "Tell this code to the person approving you". It asks `JOIN_STATUS_PATH` at most every 3 s, retries a network failure, 429 or 5xx quietly (the third in a row shows the error) and, on `approved`, shows "You're in" and goes to `next` ([gateway.md, Access requests](gateway.md#access-requests)).
  - `ProblemDetails.attemptsRemaining` in [`common.ts`](../../packages/engine-api/src/common.ts): optional, on 422 `access-code-mismatch` from `POST /access-requests/{id}/approve`, the wrong codes the request still survives (`0` when this one deleted it) ([engine-api.md, Access requests](engine-api.md#access-requests)). The UI says "N tries left" with it and a general warning without it. `ENGINE_API_VERSION` stays 1.15.0.
  - The engine UI opens `/members?request=<accessRequestId>` on that request's approval dialog; the dashboard's approver email links there. Home lists each waiting person with the same link.
  - The engine UI no longer creates invite links: "Invite in the dashboard" replaces "Invite member". `POST /invites`, `GET /invites` and `DELETE /invites/{id}` stay in the contract; the UI still lists and revokes existing links.
- **Redo:**
  1. Copy `join.html`, `gateway.js` and `gateway.css` from `packages/gateway-pages/pages/` again.
  2. Check that the status answer reporting `approved` sets the session cookie and returns a safe `next`, so the waiting page signs in by itself, and that an unknown or deleted request answers 404 (the page shows it as declined). Holding the status answer is now optional; if you hold it, stay under the page's 15 s timeout.
  3. Re-vendor the contract and add `attemptsRemaining` to the `access-code-mismatch` problem.
  4. `/members?request=<id>` is a UI route: nothing to do unless your gateway intercepts `/members`. An anonymous request for it must still redirect to sign-in with the path and query in `next`.
  5. Keep serving invite creation (`POST /invites`): the UI no longer offers it, but engines without a dashboard and existing links rely on it. Nothing to change.

### 2026-11-16: Gateway pages carry the Promptbook brand kit

- **Changed:** [`gateway.css`](../../packages/gateway-pages/pages/gateway.css) takes the brand kit's ink blue for links and focus, Exo 2 for headings (system fallback, no font file), and the pages' masthead shows the official lockup as inline SVG. Endpoints, script and CSP are unchanged.
- **Redo:** optional. Copy `pages/` again if you want the same look.

### 2026-11-16: UI loader checks again when a delayed release becomes eligible

- **Changed:** [ui-loader.md, Fetch](ui-loader.md#what-the-engine-must-do): after a `delay-not-elapsed` refusal, the engine schedules one extra check at `eligibleAt` plus a few seconds of jitter, on top of the periodic check (at most 1 hour apart). Each check replaces the pending one; it is not persisted. Checklist ENG-120. No conformance check: the harness triggers checks by restarting the engine.
- **Redo:** in `src/app/web/ui-loader.ts`, in the `delay-not-elapsed` branch where `verdict.eligibleAt` is known, set one timer for `eligibleAt` plus jitter that calls `this.check()`; clear it at the start of every check and on stop. Keep the hourly interval.

### 2026-11-16: Gateway pages follow the new visual identity

- **Changed:** [`gateway.css`](../../packages/gateway-pages/pages/gateway.css) now carries the new design tokens (Inter, graphite) and soft buttons, hairline borders and teal only for links. The HTML, script, endpoints and CSP are unchanged.
- **Redo:** optional. Copy `gateway.css` again if you want the same look. Nothing behaves differently.

### 2026-11-16: Agent illustrations

- **Changed:** `AgentProfile.illustration` in [`agents.ts`](../../packages/engine-api/src/agents.ts): optional and nullable, an ID from the UI's curated set (`^[a-z][a-z0-9-]{0,47}$`, e.g. `analyst`, `support`), never markup. Engines MAY send it once the owner can choose one later; it is read-only and in no update body. Without it, or with an ID the UI does not know, the UI picks an illustration itself from the agent's origin, name and role. `ENGINE_API_VERSION` is unchanged.
- **Redo:** nothing for now.

### 2026-11-13: Chat activity: steps, working agents, linked tasks, rechecks

- **Changed:**
  - A thread now carries what its agents are doing, field for field as [engine-api.md, What agents do in a thread](engine-api.md#what-agents-do-in-a-thread) describes. In [`chats.ts`](../../packages/engine-api/src/chats.ts):
    - `Message.phase` (`progress` | `final` | `null`) and `Message.steps` (`ReplyStep { kind: reasoning | tool | note, tool, text, level }`; only a `tool` step names a tool).
    - `Chat.working` (`ChatWorking { startedAt, messageId, author, steps }`), `Chat.tasks` (`ChatTask`) and `Chat.recheck` (`ChatRecheck { cause, nextAt, rounds }`).
    - A `linked` entry `{ type: 'linked', id, chatId, createdAt, task }`.
    - `POST /chats/{chatId}/retry` (`retryChatReply`, `chats.write`, 200 `Chat`, 409 `nothing-to-retry`).
    - `chat.changed` for each of these changes, step updates at most once a second per thread.
  - The new fields are required in what an engine sends (strict schemas). The UI's readers default them, so it keeps working against your engine until you ship this. `ENGINE_API_VERSION` stays 1.15.0: a UI bundle accepts only engines at or above the version it was built with, and engines without these fields stay fully usable.
  - Conformance:
    - New checks `engine-api.chat.reply-turn`, `engine-api.chat.activity` and `engine-api.chat.retry` (ENG-119).
    - `engine-api.chat.*` now treats the first agent message after a send that is not `progress` as the reply.
    - Every chat response is still checked strictly, so an engine without the new fields fails `engine-api.schemas.responses-strict`.
- **Redo:** file and function names are those of `src/` at 0.119.0-98.
  1. **Re-vendor the contract first.** Update `src/vendor/` (`PROVENANCE.json`, `app-platform.js`) to the platform commit with this entry. `EngineApi.dispatch` checks every answer against the vendored schemas, so a new field sent before that becomes `internal-error`. Do steps 2 to 10 in the same release: once re-vendored, a chat answer that lacks a new field fails the strict check too.
  2. **Steps at the source (harness).** Make tool activity structured where it is produced, instead of joining it into one line. Extend `HarnessEvent`'s `activity` (`harness/types.ts`) to `{ type: 'activity'; text; tool?: string; detail?: string }`, keeping `text` for existing consumers. Then set it:
     - `parseStreamJson` (`harness/shared.ts`, Claude Code, Gemini, Qwen Code): for an `assistant` `tool_use` block, `tool: String(block.name)` and `detail: summarizeToolInput(block.input)`; the same for a top-level `tool_use` (`event.tool_name ?? event.name`).
     - Codex `parseLine` (`plugins/openai-codex/index.ts`):
       - `command_execution` → tool `shell`, detail the command;
       - `file_change` → tool `apply_patch`, detail the paths;
       - `mcp_tool_call` → tool `mcp__<server>__<tool>` (Claude Code's naming, so the UI shows MCP calls alike), detail `summarizeToolInput(item.arguments)`;
       - `web_search` → tool `web_search`, detail the query.
     - OpenCode `parseLine` (`plugins/opencode/index.ts`): tool `part.tool`, detail `summarizeToolInput(toolState.input)`.
     - GitHub Copilot reports no events, so its turns have `working` and no steps.
     - In `summarizeToolInput`, add the keys `title` and `name` after `description`, so a `create_task` call shows its title instead of nothing.
  3. **Steps in `ReplyProgress` (`chats/conversation.ts`).** Next to `lines`, keep `steps: ReplyStep[]`, built in `event()`:
     - `activity` with `tool` → `{ kind: 'tool', tool, text: detail ?? '', level: 'info' }`;
     - `activity` without `tool` → `{ kind: 'note', tool: null, text, level: 'info' }`, except Codex's `command exited with N` → `level: 'warning'`;
     - `reasoning` → `{ kind: 'reasoning', tool: null, text, level: 'info' }`;
     - `error` → note with `level: 'warning'`; `turn-failed` → note with `level: 'error'`;
     - the reason passed to `unfinished(reason)` → note with `level: 'error'`.

     For every step's text and tool name, apply the same bridge-secret `redact` that `sessions.observe` applies, collapse whitespace, cut the text to 500 characters and the tool name to 128. Keep `lines` and `render()` exactly as they are: a progress message's `content` stays that readable rendering.

  4. **Store the steps with the progress message** so `GET /chats/{chatId}/entries` serves them after a restart. How to store them is your Book-format decision; the contract needs only that they come back. For a progress message saved before this change, parse its stored body back into steps:
     - `- thinking: <text>` → `reasoning`;
     - `- <name> <rest>`, where `<name>` matches `^(mcp__\S+|[A-Z][A-Za-z]+)$` → `tool` with that name, text `<rest>`;
     - any other `- <line>` → `note`/`info`;
     - a trailing `(unfinished reply: <reason>)` paragraph → `note`/`error`;
     - streamed text after the blank line is not a step.

     Over 200 steps, serve the rest as further `progress` messages, or keep the latest 200.

  5. **`working` from the start of the turn.** In `replyInChat`, call `context.onLive(chat.name, { sender, startedAt, activity: [], steps: [] })` right after `agentReference` is known, before `resolveEffectiveAgent` and the Router turn. Take `ReplyProgress`'s `startedAt` from that moment. Give `LiveReply` a `steps` field with the latest 20 steps (today `activity` keeps 8 lines). In the adapter's `chat()`, emit `working: detail.live ? [{ startedAt, author, steps, messageId }] : []`, where `author` is `authorRef(live.sender)`.
     - `messageId` is `<chat>#<messages.length + 1>` while `live.text` is non-empty, else `null`.
     - In `entries()`, append the `streaming` entry only while `live.text` is non-empty, so nobody sees an empty bubble while the agent only works.
     - `queueChatReply`'s `finally` already clears the live reply when the turn ends. Clear it under the chat's Book name, which is what `onLive` keys by.
  6. **Phase and steps on messages.** In the adapter's `message()`, send `phase: message.phase ?? null` and `steps` (step 4) for a `progress` message, else `[]`. Message positions stay as they are: progress messages count.
  7. **Tasks.** In `chat()`, map `ChatDetail.tasks` (`ChatTaskCard` from `Agenda.chatTaskCards`):
     - `name`, `state` (the same 8 values) and `detail` (`?? null`, cut to 500) come straight from the card.
     - `taskId`: derive it exactly as `tasks@1` does in `app/api/tasks.ts` `project()`: `opaqueIdOf(parseReferenceValue(card.ref)?.normalized ?? normalizeAgentName(card.name))`. Factor that key out of `project()` and use it in both places. Send `null` when the engine does not advertise `tasks@1`.
     - `agentId`: derive it from `card.agent` the way `participant()` derives a message author's key, so it matches the thread's members; `null` without an agent.
     - `commit`: `card.commit` when it matches `^[0-9a-f]{7,64}$`, else `null`.
     - `reopened`: add it to `ChatTaskCard` from the task model's `reopened`, as `tasks.ts` already reads it from `taskReadSnapshot().tasks[].reopened`.
     - `startedAt`: for a running card, the active unit's `startedAt` (`CurrentWorkView`); else the latest result's `startedAt`.
     - `endedAt`: for `completed`, `failed`, `cancelled` or `retired`, the latest result's `endedAt` (`ResultView`), else `null`. Read results from `state.recentResults(n)`, as `tasks.ts` `occurrences()` does, not only `this.recentResults`, which keeps 20. `null` is allowed when the engine no longer knows, but never send an `endedAt` for an unfinished task.
     - Keep `receipts` out: the contract has no field for them.
     - `listChats` and `listAgentChats` build `Chat` without a detail today. Add a public `Agenda` method that returns live, recheck and task cards for every chat in one pass (read the inventory once), and fill `working`, `tasks` and `recheck` for list items too.
  8. **The `linked` entry.**
     - Make `parseChatBook` (`chats/chat-book.ts`) return each `LINK` with its position among the `CHAT MESSAGE` commitments (from the commitment's `startLine`), not only `links: string[]`.
     - In `entries()`, emit `{ type: 'linked', id, chatId, createdAt, task }` right after the message it follows. Its `id` is `<chat>#linked:<normalized task name>` and its `task` is the task's name. A `LINK` in the header comes before the first message.
     - Emit one only for a `LINK` that names a task with a card, and use the card's `name` so `task` matches `Chat.tasks`. Every card needs a `linked` entry: for a card that came only from `TASK ORIGIN Chat {…}`, place it before the first message after the task's creation.
     - A `LINK` has no time of its own: `createdAt` is the preceding message's `at`, else the chat's `createdAt`.
  9. **Recheck and retry.**
     - In `chat()`, send `recheck: detail.recheck ? { cause: cut to 500, nextAt, rounds } : null` (`ChatRecheckView`). `cause` must not be empty: fall back to a plain "The reply failed." when the view has none. It is already `null` while a recheck turn runs, which is what the contract wants.
     - Add `public chatRetry(name): 'started' | 'running' | 'none'` to `Agenda`. With no `chatRechecks` entry, it returns `none`. If the entry has no armed `timer`, the attempt is queued or running, so it returns `running`. Otherwise it calls `startChatRecheck(nameKey(name), 'asked to retry now')` and returns `started`.
     - Serve `retryChatReply` with it: an unknown chat is 404 `not-found`, `none` is 409 `nothing-to-retry`, and both other outcomes answer 200 with the chat as `getChat` builds it.
     - Audit it as `chat.reply.retry` (new in `AUDIT_ACTIONS`), target kind `chat` with the chat's ID, exactly as you audit `chat.reply.cancel`.
  10. **`chat.changed`.** Today `eventDigest()` hashes only count, status, unread, title and pings, so none of the above is announced. Add to each chat's digest:
      - whether a live reply runs, and its sender;
      - progress content (an in-place progress save changes no count);
      - each task card's `name`, `state` and `detail`, and the number of links;
      - the recheck's `nextAt` and `rounds`.

      Keep the live steps in a separate part of the digest, and remember per chat when you last emitted for them. If only that part changed less than 1 s after the last emit, keep the previous value of that part and arm a wake at last emit + 1 s, so the change goes out then. Any other change emits at once.

  11. Re-run the `engine-api` suite; the three new checks and `engine-api.schemas.responses-strict` must pass. Then open the demo project's copywriter thread (`chats/2026-11-13-1201-chatter-new-chat.book`) through the UI. It should show Chatter's steps (`Glob …`, `Read …`, `mcp__ptbk__create_task …`), the task card with commit `67b252ca` and no bullet lists of tool calls. The in-memory engine's `chat-copywriter` demo thread is the reference.

### 2026-11-11: Certificate transparency watch

- **Changed:** the hourly check of the public certificate logs, which warns the owner about a certificate for the engine's address that someone else made, is now tracked. The dashboard's trust page will promise it once engines ship it. The spec always asked for it ([Residual risks](../spec/zero-trust-spec.md#residual-risks-certificates-and-engine-updates), item 1); it is now tracked as ENG-122 in the [checklist](checklist.md#tunnel-interfaces-2-and-3).
- **Redo:** implement it per the spec: every hour, check the CT logs for each of the engine's hostnames, and warn the owner (UI, email, push) about any certificate whose key is not the engine's.

### 2026-11-11: Where a release build gets its trust policy, and live staging

- **Changed:** a release build reads its trust policy from `PTBK_UI_TRUST_POLICY_FILE`: an absolute path, read once at startup before registering, parsed strictly with `TrustPolicy`, never fetched. A staging policy (`isStagingPolicy`) refuses startup in production, which means `NODE_ENV=production` at runtime or inlined at build time. Without the variable there is no policy until production pins one after the key ceremony (pending): the loader stays off and the engine serves its plain "no verified UI release" page. The conformance build is unchanged with `PTBK_CONFORMANCE_TRUST_FILE`, and behaves like a release build without it. New launch option `--engine-production-cmd` and checks `ui-loader.trust-policy.staging-refused-in-production` and `ui-loader.trust-policy.staging-accepted-outside-production` (ENG-116). New guide [staging.md](staging.md) and a read-only check, `ptbk-conformance staging` (ENG-117). The mock engine reads the same variable (its old `MOCK_UI_TRUST_POLICY_FILE` still works). See [ui-loader.md](ui-loader.md#where-the-trust-policy-comes-from).
- **Redo:**
  1. Read `PTBK_UI_TRUST_POLICY_FILE` in every build as above. Refuse a relative path, a file over 64 KiB, invalid JSON or an invalid `TrustPolicy`, and the variable together with `PTBK_CONFORMANCE_TRUST_FILE`: exit non-zero, error naming the variable and the path, never the contents.
  2. In production, refuse a staging policy before you register, dial or fetch, with `PTBK_UI_TRUST_POLICY_FILE: <path> is a staging trust policy, which must not be used in production`. Find out whether your bundler inlines `NODE_ENV`; if it does, a staging run needs a build without that.
  3. Without a policy, never fetch a release; serve the plain page. Never fall back to a policy from the release store, a mirror, the dashboard or anything else fetched.
  4. Set `NODE_ENV=production` in your release image and service.
  5. Re-run the `ui-loader` suite with `--engine-production-cmd "NODE_ENV=production <start command of your release build>"`; both `ui-loader.trust-policy.*` checks must pass.
  6. Run your engine against staging as [staging.md](staging.md) says, and run `ptbk-conformance staging --engine https://<engineId>.engines.ptbk.link` until no check fails. Include its `--json` output in your report.

### 2026-11-11: The engine opens its setup link

- **Changed:** onboarding is now "paste one command, confirm a passkey". When the engine first becomes reachable while it has no owner, the foreground process on an interactive terminal (the installer, `ptbk start` in the foreground, or `ptbk connect --link` against a running engine) prints the setup link and QR itself and, on a local desktop, opens it in the default browser. `setup-link` stays as the fallback and opens too. The printed link is a clickable OSC 8 hyperlink where the terminal renders one, and the engine sends a heartbeat at once after the owner's first passkey, so the dashboard's tab turns ready within seconds. No contract or conformance change; the dashboard's "waiting for the owner" row now points to that browser window. See [installation.md](installation.md#the-setup-link), items 3 to 5, and ENG-118.
- **Redo:** implement it exactly: open only on macOS without `SSH_CONNECTION`/`SSH_TTY`, or on Linux with `DISPLAY` or `WAYLAND_DISPLAY` and not over SSH; exec `open` or `xdg-open` with the URL as a single argument, never through a shell; `--no-open` and `PTBK_NO_OPEN=1` turn it off; without a TTY never print or open the link; with an owner, do nothing.

### 2026-11-10: Staging trust policies with short delays

- **Changed:** `TrustPolicy` takes an optional `"profile": "staging"`. Without it, the delays stay exactly 72 h and 24 h; with it, both may be anywhere from 1 minute up to those values (security no longer than regular), so staging UI releases install within minutes. Keys, threshold, workflow identity and revocation rules are unchanged. `@ptbk/protocol` adds `ProductionTrustPolicy`, `StagingTrustPolicy`, `STAGING_MIN_DELAY_MS` and `isStagingPolicy`; `ConformanceTrustFile` accepts only a production policy, and the `ui-loader` checks still expect the production delays. See [ui-loader.md](ui-loader.md#what-the-engine-must-do) and the spec's Updates section.
- **Redo:** your UI loader must accept a trust policy with `profile: "staging"` and its shorter delays only outside production, and a production build must refuse to start with one, with an error naming the policy file (the mock engine's `readTrustPolicy` is the reference). Never let anything fetched over the network choose or change the policy.

### 2026-11-06: Linking with a link URL

- **Changed:** the dashboard hands out the link code inside a link URL, `https://<dashboard host>/link#<code>`, and its install commands run `connect --link '<link URL>'` with no `PTBK_DASHBOARD_URL` or `PTBK_ENGINE_DOMAIN`. `@ptbk/protocol` adds `formatLinkUrl`, `parseLinkUrl`, `parseLinkArgument` and `LINK_PATH`; the mock engine is the reference. The launch contract (`PTBK_LINK_CODE`, `PTBK_DASHBOARD_URL`) and the conformance checks are unchanged. See [identity-and-registration.md](identity-and-registration.md#link-url).
- **Redo:** accept the link URL as well as a bare code in `ptbk connect --link`; register with the URL's dashboard origin and refuse (naming both origins) when `PTBK_DASHBOARD_URL` names another one; print that origin before registering; keep it with the registration and use it when `PTBK_DASHBOARD_URL` is unset, so a restart without the variable (after a reboot, from the service) keeps working; never print, log or store the code or the URL.

### 2026-11-06: Link codes live 30 days

- **Changed:** a dashboard link code (`connect --link <code>`) stays valid for 30 days instead of 30 minutes, because people install the engine later. It is still single use; the owner can revoke an unused one on Engines, and a team's new code ends its earlier one. The registration contract and `invalid-link-code` (unknown, expired, cancelled or used alike) are unchanged. See [installation.md](installation.md#must-report).
- **Redo:** nothing, unless your CLI or UI says a code expires after 30 minutes; say 30 days. Keep the registration retry window short (30 minutes): a code's lifetime is no reason to retry for weeks.

### 2026-11-05: engine API 1.15.0

- **Changed:** `ENGINE_API_VERSION` is 1.15.0. It covers every 2026-11-05 entry below (breaking changes made in place before the E-02 freeze; 2.0 is reserved for the freeze).
- **Redo:** report `engineApiVersion` 1.15.0 once the entries below are done.

### 2026-11-05: Secrets became the engine's Wallet

- **Changed:** the `/secrets` routes, `SecretMetadata`, the `secrets.read` and `secrets.manage` permissions, problem `secret-revoked` and the `secret.*` audit actions are gone. In their place the capability `wallet@1` maps onto Reborn's Wallet operations (`wallet`, `wallet-save`, `wallet-remove`, `wallet-seen`, `wallet-reject`): `GET /wallet`, `POST /wallet/records`, `PUT`/`DELETE /wallet/records/{recordId}`, `POST /wallet/requests/{requestId}/seen` and `…/reject`, with permissions `wallet.read` and `wallet.manage` (adding, updating and removing a login need step-up; seen and reject do not), problems `wallet-not-ready` and `wallet-request-moved`, audit `wallet.record.*` and `wallet.request.*`. Passwords and field values are write-only; setup, recovery words, import, rotation, reset and credential tests stay off the API. Integrations keep `SecretRef` by name only. Conformance: `engine-api.secrets.never-returned` now plants canaries as a Wallet password and field value, `engine-api.secrets.lifecycle` and `engine-api.integrations.secrets-never-returned` are gone, `engine-api.wallet.lifecycle` and `engine-api.wallet.requests` are new (the latter needs the optional `ConformanceTarget.walletRequest` lever). See [engine-api.md](engine-api.md#wallet) and ENG-80.
- **Redo:** drop any `/secrets` handlers and tables. Serve `wallet@1` from the engine's own `WalletSubEngine` (`view()`, `save()`, `remove()`, `markSeen()`, `reject()`), mapping `WalletActionView` to `WalletRequest` and the record view plus `accounts()` usernames to `WalletRecord`; advertise it and grant the two permissions in your policy. Offer `walletRequest` in your conformance target if you can, then re-run the `engine-api` suite.

### 2026-11-05: Chats are the engine's threads

- **Changed:** [`chats.ts`](../../packages/engine-api/src/chats.ts) models a chat as the engine's `CHAT` thread ([engine-api.md, Chats](engine-api.md#chats)). `Chat` drops `agentId`, `source` and `createdBy` and gains `status`, `members`, `unread` and `questions`; `ChatId` and `MessageId` are opaque engine references (`<chat>#<position>`). `POST /agents/{agentId}/chats` became `POST /chats` (Chatter unless `agentId` is given; 409 `chatter-missing`). `GET /chats/{chatId}/messages` became `GET /chats/{chatId}/entries` (`message`, `joined`, `titled`, `status`, newest first). Every `Message` has `author: { kind, key }` and `choices` instead of `role`. Sending answers 202 `{ message }` (no `replyMessageId`); replies are entries of their own, and the stream route streams any message still `streaming`. New: `requestKey` on create and send (409 `request-key-reused`), `replyTo` on send, `POST /chats/{chatId}/read` and `POST /chats/{chatId}/seen`. The creator-only write rule is gone. Conformance adds `engine-api.chat.thread-joins`, `.authorship`, `.idempotent-send`, `.read-and-seen` and `.default-chatter`.
- **Redo:** serve chats from the engine's chat Books: map threads, members, `CHAT TITLE`/`CHAT STATUS`/`CHAT MEMBER` and messages to the new schemas, with message IDs from `<chat>#<position>`; implement `requestKey` (per member, per thread), `replyTo`, `read` and `seen` on your attention store (`chat-read`, `chat-seen`); drop the 403 for writing in another member's chat; stream partial text for any agent message; re-run the engine-api conformance suite.

### 2026-11-05: Engine-driven onboarding

- **Changed:** new capability `onboarding@1`: `GET /onboarding`, `POST /onboarding/answer`, `POST /onboarding/defer`. Your initializer presents its prompts (text or intent, choice, confirm, upload through `files@1`, harness login with URL, code and status) and the UI only renders and answers them, like your desktop client's prompt transport. New problem `onboarding-prompt-stale`, new checks `engine-api.onboarding.state` and `engine-api.onboarding.refusals` (ENG-115). See [engine-api.md](engine-api.md#onboarding).
- **Redo:** expose the pending App-started `ptbk init` through these routes: map each prompt to a kind, keep choice values and drafts in the engine, report the harness adapter's real sign-in (Codex `--device-auth` URL and code, Claude URL plus returned code) and its readiness, and treat `defer` as "set up through the built-in agents". Never log a code or send it as chat; leave Wallet setup out.

### 2026-11-05: Activity follows capabilities

- **Changed:** `GET /activity` lists no item of a capability the engine does not advertise (`ACTIVITY_CAPABILITIES`). See [engine-api.md](engine-api.md#capabilities).
- **Redo:** nothing if you only write activity for what you serve; otherwise filter it.

### 2026-11-05: Agent origin and the built-in agents

- **Changed:** every `Agent` has `origin`: `content`, `core` (Chatter, Adam, Tasker, Router, Fixer, Teacher) or `system` (Expert), and `GET /agents` takes `origin=` with one value or a comma-separated set. `profile.description` is the one-line role the UI shows for built-in agents. Changing, deleting, restoring or saving the source of a `system` agent is 409 `agent-engine-owned` (new problem code). New check `engine-api.agents.origin`. See [engine-api.md](engine-api.md#agent-origin).
- **Redo:** send `origin` on every agent from the Book's definition ownership (your `ChatAgentChoice` groups map onto it), list Expert as `system` and refuse changes to it with `agent-engine-owned`, filter by `origin`, and make each core Book's description its role.

### 2026-11-05: Tasks

- **Changed:** a new read-only capability, `tasks@1` ([engine-api.md](engine-api.md#capabilities), [tasks.ts](../../packages/engine-api/src/capabilities/tasks.ts)): `GET /tasks`, `GET /tasks/{taskId}` and `GET /tasks/{taskId}/occurrences` report your task inventory as Reborn models it (ordinary and engine-owned tasks in one list, your readiness kinds as `state`, `TASK PARENT`, `TASK DEPENDS ON`, `TASK ORIGIN`, the directed `LINK` graph, recurrence, reopen cycles and retries as occurrences), plus the `task.changed` event and the `tasks.read` permission. `Run` gained `taskId` and `occurrenceId` (both `null` for work outside a task, such as a chat reply), and `GET /runs` a `taskId` filter. Conformance adds `engine-api.tasks.*` (ENG-111).
- **Redo:** serve the three routes from your task views (`taskInventory`, task detail, the runs of each definition) with `Task.id` an opaque ID you derive from the normalized Book name or the engine-owned definition, and advertise `tasks@1` once they pass `--suite engine-api`. Send `taskId` and `occurrenceId` on every run. Report `allowedActions: []` until we agree which task-control operations the App may call; changes stay in chat.

### 2026-11-05: Features Reborn does not have are capabilities

- **Changed:** five former core features are capabilities, so an engine without them leaves them out of `GET /engine` and answers their routes with 404 `capability-not-supported`: `members@1` (invites, role changes, removals; member reads and `/me` stay core), `api-tokens@1`, `audit@1`, `book-editor@1` (saving and validating Book source, revisions) and `agent-management@1` (visibility, folder, restore). Their conformance checks skip when not advertised. The mock starts in a `reborn` profile that advertises only what Reborn has; `MOCK_PROFILE=full` shows everything. See [engine-api.md](engine-api.md#capabilities).
- **Redo:** advertise only what you serve. Reborn has none of the five yet: leave them out and answer their routes with 404 `capability-not-supported`.

### 2026-11-05: Live audio, video and the browser tab (design only)

- **Changed:** engine API 1.14.0 reserves `live-audio@1`, `live-video@1` and `browser-tab@1` in `RESERVED_CAPABILITIES`, with two `draft` routes (`openLiveAudioSession`, `openBrowserTabSession`), the `browser.control` permission and a channel path; conformance adds `engine-api.live.reserved` and two registered stubs. The tunnel protocol is unchanged. Design: `<PLATFORM_DIR>/docs/engine-integration/live-sessions.md`, ADR 0019.
- **Redo:** nothing to build. Do not advertise these capabilities; let the two routes answer 404 `capability-not-supported` like any unadvertised capability; give `browser.control` to owners only. Send the open questions at the end of the design to the maintainer.

### 2026-11-05: Change log

- **Changed:** contract changes before E-02 are made in place and listed here. The engine API is being aligned with the Reborn engine (`specs/app/integration.md`); expect several entries.
- **Redo:** nothing yet. Read this section first from now on.

## Context

- The platform (relay, dashboard, UI bundle) never sees engine content. The relay only pipes TLS bytes; the dashboard only links an engine to an account and receives numbers in heartbeats. Everything you build keeps it that way.
- The contracts are code: `@ptbk/protocol` (wire formats between engine, relay and dashboard), `@ptbk/engine-api` (the HTTP API the UI uses) and `@ptbk/conformance` (the suite that proves an engine). They live in `<PLATFORM_DIR>/packages/`. When the guide and the code disagree, the code wins.
- Our mock engine in `<PLATFORM_DIR>/apps/mock-engine/` implements every contract and is the reference implementation. Read it, port its logic where it fits, but never copy its dev-only parts (listed below).
- The engine consumes the contracts from `<PLATFORM_DIR>` by path. That is the supported way, not a workaround: phase 0 of the plan spells out the commands. Never copy contract sources, schemas or packed tarballs into `<ENGINE_DIR>`; the checkout is the one source. Whether and when this work goes public is the maintainer's decision; follow his instructions for branches and pushes.
- Our test stacks are in `<PLATFORM_DIR>/e2e/` and our conformance CLI is built from `<PLATFORM_DIR>/packages/conformance/`. You run them; you never change them.
- `<PLATFORM_DIR>` is read-only for you. Never edit, commit to, push to or open issues or pull requests in it or in any repository other than `<ENGINE_DIR>`. Contract problems go to the maintainer (see "When a contract looks wrong").

## Read first, in this order

1. `<PLATFORM_DIR>/docs/engine-integration/README.md`: the system, the glossary and the open points. Do not build against an open point; follow what the plan says for it.
2. `<PLATFORM_DIR>/docs/engine-integration/implementation-plan.md`: the phases you will work through. This is your task list.
3. `<PLATFORM_DIR>/docs/engine-integration/cryptography.md`: the encodings every signature uses.
4. `<PLATFORM_DIR>/docs/engine-integration/testing-against-the-platform.md`: how to run the checks.
5. `<PLATFORM_DIR>/apps/mock-engine/README.md` and `<PLATFORM_DIR>/packages/conformance/README.md`: what the reference implementation does, and what every check does to an engine.
6. `<PLATFORM_DIR>/docs/engine-integration/checklist.md`: every requirement with its ID (`ENG-xx`). Track your progress by these IDs.
7. The engine repository's own agent instructions (`<ENGINE_DIR>/AGENTS.md` and whatever it includes). Follow them for code style, changelog and tests, unless they conflict with a rule below; then the rule below wins and you tell the maintainer.

Each phase in the plan names the topic file and the sections to read for it. Read them when you start that phase, not all at once.

## Rules you must never break

These are the zero-trust guarantees on the engine side. A change that would weaken one is not yours to make: stop and ask the maintainer.

1. **Strict in, tolerant out.** Parse every input strictly with the contract's schemas: unknown fields, repeated query parameters and out-of-range values are refused. Read what the dashboard and relays send with the contract's tolerant readers (`TolerantRegisterEngineResponse`, `TolerantProblemDetails`, `parseRelayMessage`). Send responses with no field the contract does not declare.
2. **Use the contract, never a copy of it.** Import the exports the guide names. Never re-type a schema, re-implement `signingInput`, signature verification, the frame codec or `verifyRelease`, or hard-code a path or constant the contract exports. If you cannot import a package in your environment, stop and ask.
3. **No dynamic code.** No `eval`, `new Function`, `vm` or string timers in anything you add, and nothing you add may call existing code that does. Add a lint rule for it in the new code.
4. **The gateway is in front of everything.** In tunnel mode the gateway is the only thing that listens. The app server listens on 127.0.0.1 only. Anonymous requests reach only the sign-in page, the WebAuthn endpoints, the setup page and agents the owner marked public. Authorisation runs in one policy module, deny by default.
5. **Replace the old access code, do not port it.** The engine's existing login, session cookie, API token checks, CORS handling and middleware access checks must not sit in front of the engine API or the UI. The gateway replaces them. Never port server code from the old agents server into the gateway. If you can read `<PLATFORM_DIR>/docs/security/agents-server-review.md`, read it before phase 6: it lists that code file by file with what replaces it. It is private, so never quote it in the engine repository, a commit message or a public issue.
6. **The engine origin serves only the gateway pages, the engine API and our verified UI bundle.** No other frontend, no inline scripts or styles, no custom JavaScript, no external origins. Send `ENGINE_UI_CSP` from `@ptbk/engine-api` byte for byte, with the other headers in `gateway.md`. Model output never becomes executable.
7. **Key handling.** The engine key is created and stored exactly as `identity-and-registration.md` says (0700 directory, `O_EXCL`, 0600, `fsync`, ownership checks, non-extractable at runtime) and is used only through `signingInput` contexts. The ACME account key and the TLS keys are separate keys. Never compare signature bytes; only verify. Random values come only from a CSPRNG. Secrets are compared as digests in constant time.
8. **Never log content or credentials.** Logs, errors, audit `details` and test snapshots never contain keys, signatures, the link code, the setup secret, session tokens, cookies, API tokens, secret values, prompts, messages, file content or heartbeat bodies. Log codes, statuses and IDs.
9. **Secrets are write-only.** No response, stream, log or error ever returns a secret value.
10. **Nothing leaves the engine unless it is on the list.** The engine contacts only the relays, the dashboard API, the release store and destinations the owner configured. No telemetry or error reporting is on by default in tunnel mode.
11. **Test hooks stay out of production.** Never copy the mock engine's control listener (`/__mock/`), its dev login, its fault injection or its fake provenance verifier. Any test-only switch you need is off by default, refused when `NODE_ENV=production`, never reachable through the tunnel, and agreed with the maintainer first.

## The loop

Work through `implementation-plan.md` one phase at a time, in order. For each phase:

1. Read what the phase lists. Study the mock engine files it names.
2. Write the tests first: the golden vectors the phase names, then the reject paths (forged signature, replay, downgrade, wrong relay, missing permission), then the happy path.
3. Implement it in the place the plan suggests, or a better one in this repository; say why if you deviate.
4. Run the phase's commands. A check that fails is a bug in the engine until proven otherwise: read its detail, fix the engine, run it again. Repeat until every check the phase names passes.
5. Run the engine repository's own tests and lint.
6. Commit with a message that names the phase and the `ENG-xx` IDs it completes. Update your copy of the checklist.

Never skip, weaken or filter out a check to get green. A check may report `skip` only for the reasons the plan allows: a capability you do not advertise yet, or a check that needs a later phase's work.

## Not yet: live audio, video and the browser tab

Full-duplex voice in a chat, later video, and the owner driving one engine browser tab to sign in to a site are designed but not buildable yet: read `<PLATFORM_DIR>/docs/engine-integration/live-sessions.md` once, for its open questions, and build none of it. They ride inside the browser's TLS to the engine as a WebSocket on the engine origin, so nothing in the tunnel, relay or registration changes for them.

## When you are done

The engine is done when all of these hold. Run them on a **conformance build** of the engine (the build that ships `conformance-session` and may read `PTBK_CONFORMANCE_TRUST_FILE`; a release build refuses both).

1. **Every conformance suite passes**, in one command that starts the engine itself and plays the dashboard, the relays and the release store, and reaches the engine API through its relay:

   ```sh
   node "<PLATFORM_DIR>/packages/conformance/dist/ptbk-conformance.js" \
     --engine-cmd "<start command of your conformance build>" --engine-cwd "<ENGINE_DIR>/<package>" \
     --engine-production-cmd "NODE_ENV=production <start command of your release build>" \
     --engine-session-cmd "<your engine> conformance-session" \
     --engine-ca-file "{dataDir}/<path of its development CA certificate>" \
     --suite engine-api,registration,heartbeat,tunnel,ui-loader \
     --report junit --out conformance-report.xml
   ```

   Run it without any heartbeat interval override, so `heartbeat.cadence.interval` proves the production 60 s. It exits 0 only when no check failed.

2. **The local dev stack works** with your engine in place of the mock (`testing-against-the-platform.md`, section "(b) The local dev stack"). Link it with a link code, see it online in the dashboard, open it through the relay and sign in with a passkey, with no CSP violation in the browser console. For the UI part, `bun run dev:stack up --no-system --engine real` runs your conformance build with a UI release signed for it.
3. **Your engine works on live staging** (`staging.md`): linked on `app.ptbk.io`, a Let's Encrypt certificate through the relay, our signed UI installed with the staging trust policy, and `ptbk-conformance staging --engine https://<engineId>.engines.ptbk.link` with no failure.
4. **No skips except these:** `capability-not-advertised` for capabilities you chose not to ship, and `engine-api.cross-member.private-resources`, which needs a target module (`testing-against-the-platform.md`, section "Against a running engine").
5. **Every `ENG-xx` row** in `checklist.md` is implemented, or is marked in the plan as not required yet.
6. **The engine repository's tests and lint pass**, and the changes are documented the way its own instructions require.

Then write a short report for the maintainer: what you built, where it lives, the conformance summary (`passed`, `failed`, `skipped`), the dev stack result, the staging check's output, and every open question or contract proposal from the next section.

## When a contract looks wrong

The contracts are shared with the relay, the dashboard and the UI. A private change on your side breaks them, so:

- **Never diverge.** Do not change a wire format, add an undeclared response field, rename a path or loosen a check, even if the contract looks like a mistake.
- **Write a proposal** for the maintainer, who raises it with the platform team: what you expected, what the contract or a check does, the check ID or file and line, why it matters, and the smallest change that would fix it. Until E-02 the platform makes the change in place and lists it under "What changed"; after E-02, changes go in by addition (a new optional field, a `v2` next to `v1`), never by editing `v1`.
- **Keep going.** Implement the rest of the phase against the contract as it is. If you are blocked, stop that item, say so in your report, and move on to the next phase only if it does not depend on it.
- **Ambiguity is a question, not a choice.** If the guide leaves a behaviour open and the plan gives no default, ask. Do not guess on anything security-related.
