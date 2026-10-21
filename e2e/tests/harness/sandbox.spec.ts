import { readFile, readdir } from 'node:fs/promises';

import { expect, test } from '../../src/fixtures.ts';

interface ChromiumProcess {
    readonly args: readonly string[];
    /** The `NSpid` line: one PID per PID namespace the process is nested in. */
    readonly namespacePids: readonly string[];
}

async function chromiumProcesses(): Promise<readonly ChromiumProcess[]> {
    const processes: ChromiumProcess[] = [];
    for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            // Chromium rewrites its children's command lines into one space-separated string (setproctitle).
            const args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split(/[\0 ]/).filter((arg) => arg !== '');
            if (!args.some((arg) => arg.includes('/ms-playwright/'))) continue;
            const status = await readFile(`/proc/${entry}/status`, 'utf8');
            const namespacePids = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.split(/\s+/) ?? [];
            processes.push({ args, namespacePids });
        } catch {
            // The process ended while we looked.
        }
    }
    return processes;
}

// The playwright container holds the Docker socket, so the browser must never run unsandboxed or as root there.
// Headless Chromium has no chrome://sandbox page, so the evidence comes from /proc.
test('Chromium runs with its sandbox on, as a user other than root', async ({ page, spikeUrl }) => {
    expect(process.getuid?.()).not.toBe(0);
    await page.goto(spikeUrl);

    const processes = await chromiumProcesses();
    expect(processes.length).toBeGreaterThan(0);
    expect(processes.filter((chromium) => chromium.args.includes('--no-sandbox'))).toEqual([]);
    const renderers = processes.filter((chromium) => chromium.args.includes('--type=renderer'));
    expect(renderers.length).toBeGreaterThan(0);
    for (const renderer of renderers) {
        // The namespace sandbox gives every renderer a PID namespace of its own, nested in the container's.
        expect(renderer.namespacePids.length, 'renderer in its own PID namespace').toBeGreaterThan(1);
    }
});
