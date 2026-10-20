// The `publish` job (X-03): uploads a verified release to R2 through the S3 API, never overwriting a version.
//
//   R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com R2_BUCKET=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
//     bun run --filter @ptbk/engine-ui release:publish --version <version>
import { parseArgs } from 'node:util';

import { EngineVersion } from '@ptbk/protocol';
import { z } from 'zod';

import { RELEASE_DIR } from './release/paths.ts';
import { publishRelease, releaseUploads } from './release/r2.ts';

const { values } = parseArgs({ options: { version: { type: 'string' } } });
const version = EngineVersion.parse(values.version);
const env = z
    .object({
        R2_ENDPOINT: z.url({ protocol: /^https$/ }).regex(/[^/]$/),
        R2_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        R2_ACCESS_KEY_ID: z.string().min(1),
        R2_SECRET_ACCESS_KEY: z.string().min(1),
    })
    .parse(process.env);

const outcome = await publishRelease(
    {
        endpoint: env.R2_ENDPOINT,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    releaseUploads(RELEASE_DIR, version),
);
if (outcome.kind === 'exists') {
    console.error(`refused: ${outcome.key} already exists; a published version is never overwritten`);
    process.exit(1);
}
console.log(`published ${outcome.keys.join(', ')}`);
