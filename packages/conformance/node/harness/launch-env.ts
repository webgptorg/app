/**
 * The engine launch contract: the variables the harness sets and an engine must honour (docs/engine-integration,
 * identity-and-registration.md, "Launch contract"). Anything else an engine needs under test (a development login, a
 * shorter interval) is engine-specific and goes into the command or a target factory's `engineEnv`, never here.
 */
export const LAUNCH_VARIABLES = [
    'PTBK_DATA_DIR',
    'PTBK_MODE',
    'PTBK_ENGINE_DOMAIN',
    'PTBK_DASHBOARD_URL',
    'PTBK_LINK_CODE',
    'PTBK_RELAYS',
    'PTBK_UI_RELEASE_URL',
    'PTBK_UPDATE_POLICY',
    'PTBK_PINNED_VERSION',
    'PTBK_CONFORMANCE_TRUST_FILE',
    'NODE_EXTRA_CA_CERTS',
] as const;
export type LaunchVariable = (typeof LAUNCH_VARIABLES)[number];

export type LaunchEnv = Readonly<Partial<Record<LaunchVariable, string>>>;

/**
 * Inherited variables the engine must not see: an operator's proxy would route loopback traffic away, and anything
 * named `PTBK_*` or a CA setting would change what the harness controls.
 */
function inherited(name: string): boolean {
    const upper = name.toUpperCase();
    return !(
        upper.startsWith('PTBK_') ||
        upper === 'HTTPS_PROXY' ||
        upper === 'HTTP_PROXY' ||
        upper === 'ALL_PROXY' ||
        upper === 'NO_PROXY' ||
        upper === 'NODE_EXTRA_CA_CERTS' ||
        upper === 'SSL_CERT_FILE' ||
        upper === 'SSL_CERT_DIR'
    );
}

/** The engine's whole environment: the parent's, cleaned, then the engine-specific extras, then the contract. */
export function engineEnvironment(
    parent: Readonly<Record<string, string | undefined>>,
    engineSpecific: Readonly<Record<string, string>>,
    launch: LaunchEnv,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parent)) {
        if (value !== undefined && inherited(name)) env[name] = value;
    }
    for (const [name, value] of Object.entries(engineSpecific)) {
        if ((LAUNCH_VARIABLES as readonly string[]).includes(name)) {
            throw new RangeError(`${name} is a launch-contract variable; pass it as launch env`);
        }
        env[name] = value;
    }
    Object.assign(env, launch);
    return env;
}
