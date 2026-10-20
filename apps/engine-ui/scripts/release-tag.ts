// Checks a pushed tag against package.json and prints `version=<v>` and `dry_run=<true|false>` for $GITHUB_OUTPUT.
//
//   bun run --filter @ptbk/engine-ui release:tag <tag>
import { readPackageVersion } from './release/paths.ts';
import { parseReleaseTag } from './release/release-tag.ts';

const packageVersion = await readPackageVersion();
const tag = parseReleaseTag(process.argv[2] ?? '', packageVersion);
if (tag.kind === 'invalid') {
    console.error(tag.reason);
    process.exit(1);
}
console.log(`version=${tag.version}`);
console.log(`dry_run=${String(tag.kind === 'dry-run')}`);
