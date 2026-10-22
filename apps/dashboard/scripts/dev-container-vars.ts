// Part of the dev container's entry point (dev-container.sh): `DASHBOARD_VARS`, a JSON object of Worker vars, replaces
// those vars in the built Worker config that `vite preview` serves. `.dev.vars` cannot carry them, because it holds
// only strings and vars such as RELAYS and HEARTBEAT are JSON. The Worker's own config parsing still validates every
// value when it starts serving, so this only checks the shape.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The built config (`dist/<worker>/wrangler.json`) with `vars` overriding its vars by name. */
export function mergeWorkerVars(configText: string, varsText: string): string {
    const config: unknown = JSON.parse(configText);
    if (!isObject(config)) throw new Error('the built Worker config is not a JSON object');
    let vars: unknown;
    try {
        vars = JSON.parse(varsText);
    } catch {
        throw new Error('DASHBOARD_VARS is not JSON');
    }
    if (!isObject(vars)) throw new Error('DASHBOARD_VARS must be a JSON object');
    const invalid = Object.keys(vars).filter((name) => !VAR_NAME.test(name));
    if (invalid.length > 0) throw new Error(`DASHBOARD_VARS: not a var name: ${invalid.join(', ')}`);
    const current = isObject(config['vars']) ? config['vars'] : {};
    return `${JSON.stringify({ ...config, vars: { ...current, ...vars } })}\n`;
}

if (import.meta.main) {
    const varsText = process.env['DASHBOARD_VARS'];
    if (varsText !== undefined && varsText !== '') {
        const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
        const configPath = join(appDir, 'dist', 'ptbk_dashboard', 'wrangler.json');
        writeFileSync(configPath, mergeWorkerVars(readFileSync(configPath, 'utf8'), varsText));
        console.log(
            `dev-container: vars from DASHBOARD_VARS: ${Object.keys(JSON.parse(varsText) as object).join(', ')}`,
        );
    }
}
