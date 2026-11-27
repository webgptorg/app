# M-13. Mock engine: AI tools with levers

- **Lane:** M · **Module:** `apps/mock-engine` · **Milestone:** M5
- **Depends on:** C-18
- **Status:** done (pushed to main)
- **Spec:** Access, transport and zero trust

## Goal

The mock engine serves `ai-tools@1` (C-18) so the UI lane and the conformance run have it, with levers to reach every state deterministically.

## Scope

- `ai-tools` among the mock's capability names and in the `full` profile; not in `reborn`, since the real engine does not serve it yet.
- Policy: admins hold `ai-tools.read` but not `ai-tools.manage` (owners only, like `browser.control`); members and viewers hold neither.
- Control routes: `POST /__mock/ai-tools/expire` (`{ aiToolId? }`, by default the tool chats run on), `renew`, `check-failure` (`{ aiToolId, problem | null }`) and `device-login` (`{ aiToolId, outcome, diagnostic? }`); 404 `capability-not-supported` without the capability.
- Checks and sign-in answers get their own rate limit (`engine-api-ai-tools-ip`, 30 a minute per client).
- The conformance target for the mock offers the `aiTools` levers.
- Docs: the mock engine's README and [mock-engine.md](../../engine-integration/mock-engine.md).

## Out of scope

- The UI (U-25), e2e scenarios.

## Acceptance criteria

- [x] Tests cover the levers, the gating, the policy, the rate limits and the capability profile.
- [x] The engine-api conformance suite passes against the mock with `ai-tools` advertised, `engine-api.ai-tools.sign-in-required` included.
- [x] **Status** line above set to `done (…)`.
