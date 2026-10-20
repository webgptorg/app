/** The mock engine `identity` CLI's report: public data only. */
export interface EngineIdentityReport {
    readonly engineId: string;
    readonly enginePublicKey: string;
    readonly hostname: string;
}

/** R-02's static registry file: C-03's `RegistryEntry` plus the engine ID. */
export interface StaticRegistryFile {
    readonly v: 1;
    readonly engines: readonly {
        readonly engineId: string;
        readonly enginePublicKey: string;
        readonly hostnames: readonly string[];
        readonly claims: readonly [];
        readonly status: 'active';
    }[];
}

const ENGINE_ID = /^[a-z2-7]{26}$/;
const BASE64URL_ED25519_KEY = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the CLI's output before it reaches the relay, so a changed report fails here, by name, rather than as a
 * relay that refuses its registry. The relay still validates the file strictly on its own.
 */
export function parseIdentityReport(value: unknown, engineDomain: string): EngineIdentityReport {
    if (!isRecord(value)) throw new Error('identity report is not an object');
    const { engineId, enginePublicKey, hostname, ...rest } = value;
    if (Object.keys(rest).length > 0)
        throw new Error(`identity report has unknown fields: ${Object.keys(rest).join(', ')}`);
    if (typeof engineId !== 'string' || !ENGINE_ID.test(engineId)) throw new Error('identity report: bad engineId');
    if (typeof enginePublicKey !== 'string' || !BASE64URL_ED25519_KEY.test(enginePublicKey)) {
        throw new Error('identity report: bad enginePublicKey');
    }
    if (hostname !== `${engineId}.${engineDomain}`) throw new Error('identity report: hostname is not the default one');
    return { engineId, enginePublicKey, hostname };
}

export function staticRegistry(identity: EngineIdentityReport): StaticRegistryFile {
    return {
        v: 1,
        engines: [
            {
                engineId: identity.engineId,
                enginePublicKey: identity.enginePublicKey,
                hostnames: [identity.hostname],
                claims: [],
                status: 'active',
            },
        ],
    };
}
