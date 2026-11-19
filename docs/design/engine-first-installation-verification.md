# Engine-first installation verification — 19 November 2026

This change completes the Dashboard presentation around the existing Reborn onboarding. Engine identity, draft persistence, `onboarding@1`, `files@1`, native harness authentication, owner passkeys and project handoff already existed. They have not been replaced. Website-owned licensing remains a separate integration.

## Reviewed installation release

The selected and minimum admitted installation metadata version is **0.119.0-117**. It includes the Codex/Claude fixes from 115. The checkout's newer 118 has not been selected or published by this work.

| Artifact               | Evidence                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm `ptbk@0.119.0-117` | Downloaded with `npm pack --ignore-scripts`; tarball SHA-512 checked against registry integrity; packaged CLI reports exactly `0.119.0-117` and documents `--prepare-only`, `--link` and `--link-stdin`.               |
| Windows x64 EXE        | Actual EXE downloaded; SHA-256 `944aa6f8c7a592806ec63d7943548048f53072e04349b88a783695afbb0e2c7a` agrees with the release asset digest and checksum sidecar. Native Windows execution remains unverified.              |
| Ubuntu bootstrap       | Downloaded at immutable commit `eda1a109787d164046d1f73732705e8a9afa76ec`; SHA-256 `8635addd31a056c97ffb234f07f9e845f57783923e185f3fb07f783d730288cd`. Same reviewed bytes as the earlier bootstrap.                   |
| macOS DMG              | Matching Apple Silicon and Intel assets/checksum sidecars are published in GitHub Releases and retained in the refreshed website catalogue. These previews are explicitly unsigned. No native macOS run was performed. |

The generated Bash/zsh block, with a placeholder instead of a real pairing capability:

```sh
npm install --global ptbk@0.119.0-117 &&
{ ptbk_installed_version=$(ptbk --version) && [ "$ptbk_installed_version" = '0.119.0-117' ] || { echo 'Open a new terminal: ptbk version mismatch.' >&2; false; }; } &&
ptbk init --prepare-only --link '<PAIRING_URL_FROM_APP>'
```

The separate PowerShell block checks `$?` and `$LASTEXITCODE` after installation and version lookup. The checked Ubuntu block verifies its immutable download before sudo and hands the pairing URL to the ordinary `promptbook` account on stdin. A pasted command can still remain in shell history.

## Automated checks actually run

| Check                                           | Result and scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard unit and client suite                 | **155 files / 1,590 tests passed.** Coverage: **98.22% lines, 95.87% branches**; existing 100% domain/config requirements passed without changing thresholds. Includes legacy linking, English/Czech rendering, copy feedback, typed responses and accessibility checks in jsdom.                                                                                                                                                                                                 |
| Copied shell blocks                             | **99 tests passed** across command execution, issuer, config and installation payload tests. Bash, zsh and portable PowerShell 7 were available. Covers npm failure, stale/mismatched CLI, quoting, literal URL fragments, verified/corrupt bootstrap and stdin handoff. System preparation is inert fixtures, not a real VPS installation.                                                                                                                                       |
| Dashboard static/build checks                   | Generation, TypeScript, scoped ESLint, formatting, production build, bundle budgets, plan validation and public engine guide validation passed.                                                                                                                                                                                                                                                                                                                                   |
| Published npm runtime                           | **38 tests passed** using the downloaded 117 `dist` and CLI, with source regression tests and dependencies supplied as test support. Covers actual identity storage, private drafts, separate pairing receipts, safe destinations, permission denial, protocol/relay adapters, prompt/file persistence, stale answers, native-terminal adapters and UI trust-policy rejection. Provider CLIs are fixtures. Four daemon-based scenarios requiring Unix sockets were excluded here. |
| Engine source focused run                       | **51 passed, 4 blocked, 18 platform skips.** Each blocked scenario fails at local IPC startup with `listen EPERM` in this execution environment; they cover daemon restart/project handoff and CLI pairing. The subsequent portable draft/owner/server subset passed **17/17**.                                                                                                                                                                                                   |
| Installer functions under portable PowerShell 7 | **33 passed, 4 Windows-only skips.** Covers dependency checks, download verification, literal paths, existing folders and reusable runtime. No native Windows installer run or PowerShell 5.1 run.                                                                                                                                                                                                                                                                                |
| Engine TypeScript                               | Passed on refreshed Reborn HEAD.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Website catalogue/bootstrap                     | **17/17 tests passed**, website lint passed with existing unrelated warnings. Catalogue refreshed from npm and GitHub, preserving original publication/listing/support history.                                                                                                                                                                                                                                                                                                   |

The built-Dashboard Chromium walkthrough was attempted, but Chromium itself aborts while creating its process-singleton Unix socket (`socket() failed: Operation not permitted`). Therefore no current desktop/mobile browser screenshots or real-browser accessibility result are claimed. This is separate from the passing client/jsdom accessibility checks. The execution environment’s socket restriction and the engine’s signature policy were left in place.

## Integration handoff to manGoweb

- New optional reviewed configuration: `ENGINE_INSTALLATION` with `version`, `windowsSha256`, `bootstrapRevision`, `bootstrapSha256`. Staging is configured for 117; production placeholders and deployment are not changed.
- The issuance-only link response adds optional typed `installationOptions`: `command`, localized `ai`, and `download`. Existing `INSTALL_COMMANDS` limits and legacy response remain supported; no heartbeat contract changes.
- `/engines/new` defaults to New project, with OS-specific blocks; paired AI installation and Windows EXE have functional payloads. Existing connect/Compose choices stay in the advanced disclosure. The AI prompts leave agenda, files and harness selection to the engine UI.
- Engine owner setup secrets never enter Dashboard. After EXE, use the checked PowerShell continuation from App; no unsupported installer deep link is assumed.
- Coordinate with existing draft **#256** before merging: that older PR addresses the Ubuntu-only default and overlaps the staging install configuration. This broader PR is a review handoff, not a request to merge both implementations.
- Engine changes are regression tests and updated public specification/changelog. Website changes explain paired versus standalone installation and refresh verified npm/EXE/DMG catalogue entries.

## Remaining release acceptance

- Run one complete real-machine flow: issue a fresh App pairing, start a real engine, create its owner passkey on its origin, add a brief/file, sign into a real supported harness, defer/reopen, confirm and use the resulting project. Also repeat the same command before/after completion and check a second engine. Automated filesystem/adapter checks are not this production acceptance.
- Supply the approved `PTBK_UI_RELEASE_URL` and `PTBK_UI_TRUST_POLICY_FILE` through the ordinary release process. Check accepted signatures, API range, delay, revocations and authenticated `/api/v1/security` UI version/hash/log index. A relay tunnel is insufficient evidence of the signed UI.
- Run native Windows PowerShell 5.1/EXE, both required macOS targets and the Ubuntu/systemd bootstrap on a disposable server. Preserve existing projects and account state; no physical restart of a production machine is required.
- Review, merge and deploy through the normal owners' workflow once these acceptance gates are met. No release, production deployment, real provider login, purchase or outbound team message was performed by this work.
