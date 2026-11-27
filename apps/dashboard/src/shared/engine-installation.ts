import { compareEngineVersions, EngineVersion } from '@ptbk/protocol';
import { z } from 'zod';

const MINIMUM_VERSION = EngineVersion.parse('0.119.0-117');

/** Published artifacts with a supported CLI. URLs are derived, never supplied by a link-code requester. */
export const engineInstallReleaseSchema = z.strictObject({
    version: z
        .string()
        .max(32)
        .refine((version) => {
            const candidate = EngineVersion.safeParse(version);
            return (
                // The pinned Ubuntu installer accepts exact versions without SemVer build metadata.
                !version.includes('+') &&
                version.trim() === version &&
                candidate.success &&
                compareEngineVersions(candidate.data, MINIMUM_VERSION) >= 0
            );
        }, 'requires 0.119.0-117 or a later semantic version'),
    windowsSha256: z
        .string()
        .length(64)
        .regex(/^[a-f0-9]{64}$/),
    bootstrapRevision: z
        .string()
        .length(40)
        .regex(/^[a-f0-9]{40}$/),
    bootstrapSha256: z
        .string()
        .length(64)
        .regex(/^[a-f0-9]{64}$/),
});

export type EngineInstallRelease = z.infer<typeof engineInstallReleaseSchema>;

const commandSchema = z.string().min(1).max(4096);
const promptSchema = z.string().min(1).max(16_000);
const targetsSchema = z.object({ local: promptSchema, server: promptSchema });

/** Separate payloads keep long prompts and downloads out of the legacy shell-template contract. */
export const installationOptionSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('command'),
        id: z.literal('new-project'),
        commands: z.object({ posix: commandSchema, powershell: commandSchema, ubuntu: commandSchema }),
    }),
    z.object({
        kind: z.literal('ai'),
        id: z.literal('ai'),
        prompts: z.object({ cs: targetsSchema, en: targetsSchema }),
    }),
    z.object({
        kind: z.literal('download'),
        id: z.literal('windows'),
        version: engineInstallReleaseSchema.shape.version,
        url: z.url({ protocol: /^https$/ }).max(512),
        sha256: engineInstallReleaseSchema.shape.windowsSha256,
        afterInstall: commandSchema,
    }),
]);

export type InstallationOption = z.infer<typeof installationOptionSchema>;
