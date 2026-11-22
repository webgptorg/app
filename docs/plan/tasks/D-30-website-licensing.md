# D-30. Website licensing and account handoff

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-07
- **Status:** in progress (#345; the website's organization-linking endpoint plugs in next)

## Goal

Implement the owner-approved 13 November split: the website owns trials, purchases and capability grants; the control App uses advisory coverage and verified account handoff. No community data, prices or permanent engine allocation enter the App contract. Preserve every authentication, authorization, rate-limit and E2E boundary.

## Acceptance

- Numeric grants support multiple heterogeneous licenses and unlimited values.
- Missing, stale, expired or exceeded licenses never stop work or prevent engine linking.
- Website-to-App handoff uses a single-use, challenge-bound server exchange; no bearer secrets in browser code.
- Existing passkeys and engine identity remain separate; handoff grants no engine access or step-up by itself.
- Website remains the only production checkout; English enquiries are contact-only.
- Provider errors preserve last known coverage and show uncertainty.

Update of 20 November 2026 (Seb): License shows the organization's licence (plan, state, term, engines and people against it). Enforcement is prepared, not on: the `engine.link` and `member.invite` check points warn, and deny only with `LICENSE_ENFORCEMENT` `enforce`, which no environment sets. Turning it on overrides the second line above for new engines and invitations only, and needs Seb's decision ([website licensing](../../design/website-licensing.md#enforcement)).

## Apply

Configure one dedicated website/App server credential only after the PR is reviewed and both ends are deployed. Do not merge this PR automatically; Pavol requested review by Sebastián.

## PR scope and remaining integration

PR #289 provides numeric schemas, advisory heterogeneous coverage, bounded polling and identity-exchange clients, identity-linking guard, the website billing selection, and the member-area link. These helpers do not expose a new authentication route or bypass the current passkey flows.

Organization-scoped persistence, typed handoff routes with normal passkey enrollment, and coverage notices remain part of D-30 and are explicitly listed in docs/design/website-licensing.md. Keep this PR draft until those changes and the actual staging integration are reviewed with the App owner. No production secrets or configuration changes are applied by this PR.
