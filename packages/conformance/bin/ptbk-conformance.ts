#!/usr/bin/env node
import { runCli } from './cli';

// Ctrl-C aborts the running check; its cleanup still runs before the process exits.
const controller = new AbortController();
process.once('SIGINT', () => {
    controller.abort();
});

process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
});
