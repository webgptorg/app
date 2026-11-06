import { z } from 'zod';

/** The install paths `/engines/new` can offer as tabs (installation.md, Install paths); a closed list. */
export const installPathIdSchema = z.enum(['installer', 'compose', 'connect']);
export type InstallPathId = z.infer<typeof installPathIdSchema>;

/** Which tab label the SPA shows; configuration picks one, so a relabelled path needs no API change. */
export const installPathLabelKeySchema = z.enum(['docker-server', 'docker-compose', 'already-running', 'new-project']);
export type InstallPathLabelKey = z.infer<typeof installPathLabelKeySchema>;

/** A heading anchor in the public install guide, e.g. `2-docker-compose`. */
export const docsAnchorSchema = z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(128);
