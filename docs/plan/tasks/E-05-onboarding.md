# E-05. Onboarding: product spec and engine install guide

- **Lane:** Engine integration · **Module:** `docs/design/`, `docs/engine-integration/` · **Milestone:** M3
- **Depends on:** E-01, D-03, D-06, D-09, M-06
- **Status:** in progress (docs/e-05-onboarding)
- **Spec:** Pairing and identity, One address for users, Moving existing deployments, Operations, Interfaces (draft) 1, 4 and 6, Build plan (Distribution); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0014](../../adr/0014-cryptography.md), [0017](../../adr/0017-billing-entitlements.md); design: [ui.md](../../design/ui.md)

## Goal

Someone who runs, or wants to run, the open engine can link it to the platform and have it just work: hostname, certificate, tunnel, signed UI and the first owner passkey. Two documents say exactly what each side shows and does to get there, so our lanes and the engine maintainer (and his coding agents) build the same flow.

## Context

The dashboard side of linking exists (D-03 link codes and registration, D-05 heartbeat status, D-06 engine list and revoke, D-09 auth screens), and the mock engine registers and heartbeats (M-06). What is missing is the flow between them as a person experiences it: there is no live view while an engine links, the install command is a placeholder outside dev, and nothing specifies the engine's terminal output, setup link or setup page. The mock engine has no setup secret at all; it signs in with a development-only member picker.

The engine is built by an external maintainer in `webgptorg/promptbook`. Today it is the `agents-server` Next.js app, distributed as a git-clone VPS installer (pm2, nginx, certbot), a stateless Docker image needing Supabase, a Vercel deploy and the `ptbk agents-server` npm command, with a password admin and no setup flow. The realistic first users are its current operators, so moving them is a first-class journey.

`docs/engine-integration/` moves public with the contracts (E-02): `installation.md` follows E-01's rules (nothing private, no infra, no secrets, relative links, the guide's content checks). `docs/design/onboarding.md` is a private product document and may name dashboard internals and task IDs.

## Scope

- `docs/design/onboarding.md`: principles, surfaces and who builds them, what each side can observe, journeys end to end (new person and new engine; existing predecessor operator and a running engine; another engine; Enterprise custom domain; members), every failure and edge case with copy per surface and the way out, what we deliberately cannot do, time-to-value targets, the gaps between this spec and `main` as proposed follow-up tasks, and the decisions a human must take.
- `docs/engine-integration/installation.md`: requirements, install paths (installer, Compose, linking a running engine), configuration, data directory, networking and proxies, the first-start output contract, the setup link and setup page, operator commands, upgrades, moving an existing deployment, troubleshooting, open points.
- `docs/engine-integration/README.md` reading order and a `checklist.md` section (ENG-100 to ENG-109) for the new requirements.
- After the human's decisions: briefs for the follow-up tasks they accept.

## Out of scope

- Implementing any of it: the follow-up tasks (D-10 to D-12, R-07, C-11, M-08, X-07) and the engine team's work.
- E-04's drift audit and implementation kit for the rest of the guide.
- Pricing (ADR 0017), the engine domain name, the migration offer for predecessor servers we host.

## Design notes

- Copy that already exists in the dashboard is quoted from `apps/dashboard/messages/en.json`; changes are marked as gaps, not made silently.
- The dashboard's live progress is built only from signals it already has or that relays hold as routing metadata (registration, heartbeat counts, tunnel presence); the setup secret never reaches us. The heartbeat's `members` count (0 until the owner's passkey) carries "owner set up" without a contract change.
- The setup link goes to the operator's terminal, never into the engine's log stream: this reconciles the spec ("the terminal prints a setup link") with the guide's rule that the setup secret is never logged, since container logs get shipped.
- Command names (`promptbook-engine …`) and flags are proposals; behaviour is normative where the platform depends on it.

## Acceptance criteria

- [x] Both documents exist, cover every journey and edge case listed in Scope, and mark each dashboard behaviour as built or as a gap with a task ID.
- [ ] The human's decisions are recorded in both documents and in this brief; open points are either decided or listed with an owner.
- [ ] Follow-up briefs exist for every follow-up the human accepted, added to the plan table, with `bun run plan --check` passing and waves regenerated.
- [x] The guide's link and private-content checks pass over `docs/engine-integration/` (`bun run engine-guide`).
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The engine maintainer has not reviewed the engine side yet; command names, the installer's location and the image name are his choice.
- C-08 (the conformance runner's engine launch contract, referred to by E-04) has no brief yet; `installation.md`'s configuration table is the proposal it should start engines with.
- A fresh engine's first UI bundle and the 72-hour delay interact (see the decisions); this needs the engine team and the release key holders.
