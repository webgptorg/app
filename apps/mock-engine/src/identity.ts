import { IdentityStoreError, createFsIdentityStore } from './adapters/fs-identity-store';
import { ConfigError, parseIdentityConfig } from './app/config';
import { identityReport } from './app/identity-report';

// Prints the public identity for the relay's static registry (X-01), creating the key on first use.
try {
    const config = parseIdentityConfig(process.env);
    const identity = await createFsIdentityStore(config.dataDir).loadOrCreate();
    process.stdout.write(`${JSON.stringify(identityReport(identity, config.engineDomain))}\n`);
} catch (error) {
    // Our own errors name settings and paths, never values; anything else may carry values, so only its name.
    const known = error instanceof ConfigError || error instanceof IdentityStoreError;
    process.stderr.write(`${known ? error.message : error instanceof Error ? error.name : 'unknown error'}\n`);
    process.exitCode = 1;
}
