# U-10. Files and knowledge

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02, C-07
- **Status:** done (#55)
- **Spec:** Security hardening (5 agent output is untrusted), Engine security baseline (Browser headers); ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

When the engine advertises `files@1`, members see every agent's knowledge and the files agents produce, with scan status and versions, can upload knowledge and delete files where permitted, and never render untrusted file content as anything but metadata or a safe raster preview.

## Context

Files come in four purposes (C-07): knowledge an agent reads, chat attachments, agent outputs (including generated images and git-backed project files whose versions are commits) and generic uploads. Every file is untrusted: outputs are produced by agents that may have read attacker-controlled input, and uploads can be anything. The engine scans files; an infected file stays visible as metadata but cannot be downloaded. The feature is a module that registers itself in the registry (U-02), so an engine without `files@1` shows no Files section, tab or card. The upload control here is the same one U-04's wizard knowledge step uses.

## Scope

- Feature module `src/features/files/` registered in `src/app/features.ts` with `defineFeature({ id: 'files', requires: { capability: files@1, permission: 'files.read' }, … })`:
  - `nav`: group `resources`, "Files", to `/files`.
  - `agentTabs`: "Files" at `/agents/$agentId/files` (knowledge first, then outputs).
  - `agentOverviewCards`: "Knowledge at a glance" (file count by purpose, latest outputs, scan problems).
  - `activityRenderers`: `file.*` (version 1) for `file.created`, `file.deleted`, `file.scan-failed`, linking to the file.
  - `attention`: count of files with scan `infected` or `failed`, linking to `/files?scan=infected,failed`.
  - `commands`: "Upload knowledge" (`files.write`), "Go to files".
- Routes `/files` and `/agents/$agentId/files` with `requireFeature('files')` in `beforeLoad`. Typed search params: `q`, `purpose`, `scan`, `agentId` (global view only), `sort`, `cursor`, all sent to C-07's `GET /files`; nothing filtered on the client.
- List: `DataTable` in server-side mode: name, purpose badge, agent, size (`Intl` formatter), type, scan status badge with text, created by, created (`RelativeTime`); card layout below 768 px; empty, no-results and error states.
- File detail as a `Drawer` from the list (URL-addressable `?file=<id>`, so it survives reload and back): metadata, SHA-256 as `CodeText` with copy, scan status and time, origin links (agent, chat, run when `runs@1` is advertised), versions from `GET /files/{fileId}/versions` (date, size, commit hash as `CodeText`, run link), download of the current or a chosen version.
- Download: a plain same-origin link to the content route (served as an attachment by the engine); disabled with an explanation for `infected` files, and a 409 `file-infected` is shown as such.
- Preview: only for `image/png`, `image/jpeg`, `image/webp` and `image/gif` with scan `clean`: an `<img>` from the same-origin content route with fixed dimensions and alt text from the file name. Never SVG, HTML, PDF or text inline; everything else is download only.
- Upload knowledge (`can('files.write')`): drop zone plus a keyboard-operable file input, per-file progress through the client's `onProgress` and `signal`, cancel, size and type limits from the API checked before upload, `purpose: 'knowledge'` and the agent ID. Exported as `KnowledgeUpload` for U-04.
- Delete (`files.write`): `ConfirmDialog` naming the file; waits for the server; toast on outcome.
- Live: `file.changed` events and `file.*` activity from the app-wide event subscription invalidate the affected list and detail; nothing polls.
- Hooks `useFiles(filters)`, `useFile(id)`, `useFileVersions(id)`, `useFileMutations()`, `fileKeys` and `queryOptions` shared with loaders.

## Out of scope

- Rich previews (PDF, office documents, text, audio, video), file editing, folders, bulk actions.
- Browsing a project repository tree or diffs (U-09 shows project changes per run).

## Design notes

- File names, types and paths are user or agent content: render as text only; never use them to build a URL other than the API route with the encoded file ID.
- `<img>` previews are safe under `img-src 'self'` only because the engine sends the declared type with `X-Content-Type-Options: nosniff`; the allow-list lives in one function next to `safe-url.ts` with its own test.
- Scan status uses an exhaustive `switch` over C-07's union with an "unknown" fallback, like U-03's agent status.
- Design-system components and semantic tokens only; no ad-hoc styles.

## Acceptance criteria

- [x] With the in-memory client's seeded files: filters by purpose, scan, agent and search narrow results, are written to the URL and restored on reload; paging reaches every file.
- [x] Infected file: download is disabled with text, a forced 409 shows the message; scan status is never colour-only.
- [x] Preview renders an `<img>` only for the four raster types with scan `clean`; SVG, HTML, PDF and an infected PNG render no `<img>`, `iframe` or `object` (DOM assertions).
- [x] A file named `<img src=x onerror=alert(1)>.png` renders as literal text.
- [x] Upload: progress, cancel, over-limit file rejected before upload, upload error and success each tested; without `files.write` upload and delete are absent.
- [x] Versions list shows commit hashes and run links (run links hidden when `runs@1` is not advertised).
- [x] A `file.changed` event updates the list without a manual refetch; `file.*` activity renders through the registered renderer.
- [x] Without `files@1` the nav item, agent tab and overview card are absent and `/files` shows "not available on this engine"; without `files.read` it shows "no access".
- [x] Skeleton, empty, no-results and error states each have a test; `axe-core` passes; `test:csp` visits `/files`, the drawer and an agent's Files tab with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); routes stay within their bundle budgets.
- [x] Every string in `en` and `cs`.
- [x] `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Upload limits and allowed types must come from the engine; if C-07 lacks them, amend the contract first rather than hardcoding.
- Whether chat attachments of other members are visible to the owner follows the engine's policy; the UI shows what the API returns.
