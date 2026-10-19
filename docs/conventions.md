# Conventions

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). commitlint checks every commit locally (git hook) and in CI.

```
<type>(<scope>): <subject>

[optional body: why, not what]

[optional footer: BREAKING CHANGE: ..., Refs: ...]
```

**Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `revert`, `style`.

**Scopes** (optional, but must be one of these): `relay`, `dashboard`, `engine-ui`, `mock-engine`, `protocol`, `engine-api`, `conformance`, `e2e`, `infra`, `docs`, `ci`, `deps`, `repo`.

**Subject:** imperative, lower case, no trailing period, about 50 characters.

```
feat(relay): route custom hostnames by signed claim
fix(dashboard): reject heartbeats with a stale seq
feat(protocol)!: rename OPEN frame client address field
ci: pin setup-bun to a commit SHA
```

A breaking change to a protocol contract needs `!` and a `BREAKING CHANGE:` footer, and it ships as a new version (`v2`) next to the old one, never as an edit of `v1`. Engines in the field keep speaking the old version.

## Branches and pull requests

- `main` is always green and deployable. Changes land through pull requests.
- Short-lived branches named `<type>/<task-id>-<short-description>`, e.g. `feat/r-01-sni-parser`. One task from the [plan](plan/README.md) per branch.
- Squash merge. The PR title becomes the commit on `main`, so it follows the same rules (CI checks it). Put `Refs: <task-id>` in the PR body.
- Agents may merge their own PR once CI is green and the self-review in [AGENTS.md](../AGENTS.md#working-on-a-task) passes.
- Keep PRs small enough to review in one sitting. Split protocol changes from the code that uses them.
- A change to architecture, a protocol contract or a security property needs an ADR in the same PR.

## Architecture decisions

Significant decisions are recorded as ADRs in [adr/](adr/). Copy [adr/0000-template.md](adr/0000-template.md), take the next number, open it as `Proposed`, and switch to `Accepted` when the PR merges. Do not rewrite an accepted ADR; supersede it with a new one.

## Versioning

The relay and the dashboard deploy continuously from `main` and carry no semver version. Protocol contracts are versioned per message (`v1`, `v2`) as described in the spec.

## Code

- Comment the why, not the what.
- Validate untrusted input at the boundary with zod; inside, trust the types.
- Prefer the platform (Node, Workers, Web APIs) over a dependency.
