/*
 * Each scenario is one run of the stack: compose.yaml plus its overlays, and the Playwright specs that need exactly
 * that topology. Specs of different scenarios cannot share a stack because the overlays change how the mock engine
 * reaches the relays. Only node: imports: cli.ts runs this before any install.
 */

export interface Scenario {
    readonly name: string;
    /** `compose.<name>.yaml` files layered over compose.yaml, in order. */
    readonly overlays: readonly string[];
    /** Spec files, relative to tests/. */
    readonly specs: readonly string[];
    /**
     * Services in the `on-demand` profile, which `up` leaves out: cli.ts only creates their container, and tests start
     * one-off copies of it with what they learn on the way (the compose fixture's `run`).
     */
    readonly onDemand?: readonly string[];
    /**
     * Specs that also run in Firefox, where Trusted Types may be missing, so the CSP is checked without them too. The
     * Chromium run stays the gate.
     */
    readonly firefoxSpecs?: readonly string[];
}

export const SCENARIOS: readonly Scenario[] = [
    { name: 'spike', overlays: [], specs: ['harness/sandbox.spec.ts', 'spike/*.spec.ts', 'ui-loader/*.spec.ts'] },
    {
        name: 'nat',
        overlays: ['nat', 'capture'],
        specs: [
            'network/nat.spec.ts',
            'network/packet-capture.spec.ts',
            'network/relay-key-scan.spec.ts',
            'network/relay-restart.spec.ts',
            'network/relay-failover.spec.ts',
        ],
    },
    { name: 'egress-443', overlays: ['nat', 'egress-443'], specs: ['network/egress-443.spec.ts'] },
    { name: 'connect-proxy', overlays: ['nat', 'connect-proxy'], specs: ['network/connect-proxy.spec.ts'] },
    {
        name: 'tls-inspecting-proxy',
        overlays: ['nat', 'tls-inspecting-proxy'],
        specs: ['network/tls-inspecting-proxy.spec.ts'],
    },
    // M-03: the engine obtains its certificate from Pebble with TLS-ALPN-01 through relay-a, which relay-a captures.
    { name: 'acme', overlays: ['acme', 'capture'], specs: ['acme/*.spec.ts'] },
    // X-05: the dashboard is the registry; the mock engine starts only once a test has a link code for it.
    { name: 'dashboard', overlays: ['dashboard'], specs: ['dashboard/*.spec.ts'], onDemand: ['mock-engine'] },
    // X-04: the owner flows in engine-ui, served by the mock engine's loader from the signed bundle, through the relays.
    {
        name: 'ui',
        overlays: ['ui'],
        specs: ['ui/*.spec.ts'],
        firefoxSpecs: ['ui/agents.spec.ts', 'ui/chat.spec.ts', 'ui/secrets.spec.ts'],
    },
];

export const DEFAULT_SCENARIO = 'spike';

/** The compose profile of services `up` leaves out (`Scenario.onDemand`). */
export const ON_DEMAND_PROFILE = 'on-demand';

/** Every overlay any scenario uses, so `down` removes whatever an earlier run left, whichever scenario it was. */
export const ALL_SCENARIO_OVERLAYS: readonly string[] = [
    ...new Set(SCENARIOS.flatMap((scenario) => scenario.overlays)),
];

export function scenarioNamed(name: string | undefined): Scenario {
    const wanted = name === undefined || name === '' ? DEFAULT_SCENARIO : name;
    const scenario = SCENARIOS.find((candidate) => candidate.name === wanted);
    if (scenario === undefined) {
        throw new Error(`E2E_SCENARIO: "${wanted}" is not one of ${SCENARIOS.map((known) => known.name).join(', ')}`);
    }
    return scenario;
}
