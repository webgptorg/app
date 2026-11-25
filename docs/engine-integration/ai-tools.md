# AI tools: status, checks and signing in again from the browser

The coding tools a project's agents run on (Claude Code, OpenAI Codex, Gemini CLI, …; the engine's harnesses) can stop working after setup: a provider sign-in expires or is revoked, a key runs out of credit, a tool is signed out. Until now the only way back was a terminal on the engine's host, which a non-technical owner of a project on a server does not have. `ai-tools@1` gives the browser that way back.

Contract: [ai-tools.ts](../../packages/engine-api/src/capabilities/ai-tools.ts). Reference behaviour: the in-memory engine's [ai-tools.ts](../../packages/engine-api/src/in-memory/ai-tools.ts) with its tests. Implementation brief for the engine: the [AGENT_BRIEF entry "AI tools management (ai-tools@1)" of 2026-11-24](AGENT_BRIEF.md), with test cases AT-01 to AT-16.

**Additive under API 1.15.0.** `ENGINE_API_VERSION` does not change: the capability is off until an engine advertises it, the UI shows nothing of it before then, and the one new field on an existing shape (`ChatRecheck.aiToolId`) defaults to `null`.

## What the owner can do

- **See** every tool the engine knows, in the engine's order: its status, how it is authenticated (an account sign-in or an API key, never the key), when a real call last went through it, and what is wrong when something is.
- **Check now**: a real call through the tool, which updates its status.
- **Sign in again**: the provider's own sign-in, completed in the browser with onboarding's `harness-login` prompt (a device code, or a code pasted back).
- **Use an API key instead**: onboarding's `secret` prompt with a link to the provider's key page. The engine verifies the key with a real call before it replaces anything.
- **Sign out**: the tool's account sign-in or key is removed from the project.

Chat turns that fail because a tool needs signing in name the tool, so the chat offers "Sign in again", and Home shows a quiet line while any tool needs it.

## The model

`AiTool`:

| Field           | Meaning                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | A stable name, the same on every engine for the same tool: `claude-code`, `codex`, `gemini-cli`, `opencode`. Opaque to the UI.                                           |
| `name`          | The tool's own name, e.g. "Claude Code".                                                                                                                                 |
| `version`       | The installed version as the tool reports it; `null` when not installed.                                                                                                 |
| `status`        | `signed-in`, `needs-sign-in`, `error` or `not-installed` (below).                                                                                                        |
| `auth`          | `{ method: 'account' \| 'api-key', account }` or `null` while the tool has no credentials. `account` is what the provider calls the account; never anything about a key. |
| `signInMethods` | The ways the owner can sign it in from the browser, in the engine's order; empty when only the host can.                                                                 |
| `checkedAt`     | When a real call through the tool last finished, whatever its outcome; `null` before the first.                                                                          |
| `checking`      | A check runs now; `ai-tool.changed` follows when it ends.                                                                                                                |
| `problem`       | `{ code, message }` exactly when `status` is not `signed-in`; `null` otherwise.                                                                                          |

Statuses:

- `signed-in`: the last real call got an answer.
- `needs-sign-in`: never signed in on this project, signed out, or the provider no longer accepts its sign-in. The owner fixes it here. Problem `not-signed-in` or `sign-in-expired`.
- `error`: signed in, but the last call failed for another reason. Problem `key-rejected`, `quota-exceeded`, `provider-unavailable` or `check-failed`.
- `not-installed`: the engine knows the tool but it is not on this host. Installing is setup's job, not this capability's. Problem `not-installed`.

`problem.message` is the engine's words or the tool's own diagnostic, e.g. "OAuth session expired and could not be refreshed". It is untrusted text the UI renders as text, and it never contains a key, a token or a login code.

## Routes

| Route                                                  | Permission        | Step-up | What it does                                                                                |
| ------------------------------------------------------ | ----------------- | ------- | ------------------------------------------------------------------------------------------- |
| `GET /ai-tools`                                        | `ai-tools.read`   | –       | `{ items }`, at most `MAX_AI_TOOLS` (16), no paging                                         |
| `GET /ai-tools/{aiToolId}`                             | `ai-tools.read`   | –       | One tool                                                                                    |
| `POST /ai-tools/{aiToolId}/check`                      | `ai-tools.read`   | –       | 202 with the tool, `checking` while the call runs; 409 `ai-tool-not-installed`              |
| `POST /ai-tools/{aiToolId}/sign-ins`                   | `ai-tools.manage` | yes     | `{ method }`; 201 `AiToolSignIn` with its first prompt; 422 `ai-tool-method-unsupported`    |
| `GET /ai-tools/{aiToolId}/sign-ins/{signInId}`         | `ai-tools.manage` | –       | The sign-in, for polling                                                                    |
| `POST /ai-tools/{aiToolId}/sign-ins/{signInId}/answer` | `ai-tools.manage` | –       | An answer or an alternative; 409 `ai-tool-sign-in-stale` for a prompt the engine moved past |
| `DELETE /ai-tools/{aiToolId}/sign-ins/{signInId}`      | `ai-tools.manage` | –       | Abandon it; the tool keeps what it had                                                      |
| `DELETE /ai-tools/{aiToolId}/credentials`              | `ai-tools.manage` | yes     | Sign out (idempotent); answers the tool, now `needs-sign-in` with `not-signed-in`           |

`ai-tools.read` is for who oversees the project (the mock's policy: owners and admins); `ai-tools.manage` decides whose model account and bill the project uses, so engine policy gives it to owners only, like `browser.control`. A check changes no credential, so `ai-tools.read` covers it; rate-limit it (the mock allows 30 a minute per client), since every check is a model call.

### A sign-in

`AiToolSignIn` is one owner's attempt to sign one tool in:

- `id`, `aiToolId`, `method` (the method shown now; an alternative switches it), `expiresAt` (the engine forgets an unfinished sign-in then), `activity` (onboarding's `OnboardingActivity`, e.g. "Check Claude Code"), `tool` (the tool as it is now).
- `status`: `pending` while a prompt waits; `working` while the engine verifies new credentials and shows none; `completed` once they are verified and in use.
- `prompt`: exactly onboarding's `harness-login` or `secret` prompt ([onboarding.ts](../../packages/engine-api/src/capabilities/onboarding.ts)), present exactly while `pending`. `canGoBack` is always `false`. A `harness-login` prompt for an account sign-in offers the alternative "Use an API key instead" when the tool has `api-key` in `signInMethods`; a `secret` prompt offers "Sign in with your account instead" the other way round. Alternatives without `href` are sent as `{ action: 'alternative', alternativeId }`.
- Answers are onboarding's `secret` (`{ value }`) and `harness-login` (`{ returnCode }`, `null` to start the login again) answers, as `{ promptId, action: 'answer', answer }`.

Rules:

1. **Bound to its session.** A sign-in belongs to the gateway session that started it. Any other session, the same member's included, gets 404 for it. Starting a sign-in for a tool ends any earlier one of that tool.
2. **Old credentials stay until new ones work.** Nothing replaces the tool's current credentials until the engine verified the new ones with a real call. A refused key comes back as a new `secret` prompt (new `id`) with `error`; a refused login as the `harness-login` prompt with `status: 'failed'` and the provider's `diagnostic`. Abandoning or letting the sign-in expire changes nothing.
3. **Keys go to the engine's store only.** A key is never sent back, logged, audited, put into an error, a chat, a Book or the heartbeat. The refusal text is fixed, whatever was pasted. Login codes (`userCode`, the returned code) are transient and treated the same way.
4. **Audit, without secrets:** `ai-tool.sign-in.start` (the route), `ai-tool.sign-in.complete` (when new credentials are verified, `details: { method }`) and `ai-tool.sign-out`, each with target `{ kind: 'ai-tool', id, name }`; denied attempts as `denied`.

### Events

`ai-tool.changed { aiToolId }` on `/events`, to members with `ai-tools.read`, whenever a tool's status, credentials or check changes. It carries the ID only; clients read the list again.

## Chat turns that need a sign-in

Work that cannot start because the tool it runs on needs signing in fails with problem code `ai-tool-sign-in-required` (503), whose extension `aiToolId` names the tool:

- A thread's `recheck` carries `aiToolId` (since 2026-11-24, default `null`) when the failed reply needs that tool signed in. The UI shows "Sign in again" on the failure, linking to `/settings/ai-tools?signIn=<aiToolId>`.
- A reply stream that fails for that reason ends with `{ type: 'failed', problem }` where `problem.code` is `ai-tool-sign-in-required` and `problem.aiToolId` is set.
- Any other route that runs a model call (a test chat, a transcription) may answer 503 `ai-tool-sign-in-required` with `aiToolId` the same way.

The engine should not keep retrying such a turn on its own schedule while the tool still needs signing in; once it is signed in again, the recheck may run at once.

## Why not reopen onboarding

The 2026-11-23 brief (item 5) suggested reopening onboarding with a `harness-login` step when a provider sign-in expires, as a stopgap. That mixes a one-time setup flow with day-to-day maintenance, hides the cause from Home and the chat, and gives admins no read-only view. `ai-tools@1` supersedes it: setup stays setup, and the same prompt shapes serve both, so neither the engine nor the UI builds the sign-in twice.

## Conformance

`engine-api.ai-tools.*`, each skipping when `ai-tools@1` is not advertised:

- `engine-api.ai-tools.check`: list and get agree, an unknown tool is 404, Check now answers 202 and settles with a fresh `checkedAt`, a tool that is not installed is 409.
- `engine-api.ai-tools.permissions`: without `ai-tools.read` no list, get or check; without `ai-tools.manage` no sign-in or sign-out (403 naming `ai-tools.manage`), and nothing changes.
- `engine-api.ai-tools.sign-in-flow`: an account sign-in shows a prompt without Back, belongs to its session, refuses a stale or mismatched answer, and leaves the credentials alone until cancelled.
- `engine-api.ai-tools.secret-never-echoed`: a made-up key comes back as a new `secret` prompt with an error, and no response (sign-in, tool, list, audit log) ever contains it.
- `engine-api.ai-tools.sign-in-required`: with the target's test-mode levers (`ConformanceTarget.aiTools`: expire and renew the sign-in of the tool chats run on), the tool reads `needs-sign-in` and a new chat turn fails naming it. Skips without the levers.

## Open for the engine team

1. Which `id` does each harness get? We propose `claude-code`, `codex`, `gemini-cli` and `opencode`.
2. Can every harness verify a key or a sign-in with a cheap real call, and how long does it take? `checking` and `working` exist for calls that take longer than a request should.
3. Does Claude Code's `claude setup-token` fit as a third method, or as an `api-key`-like secret prompt?
