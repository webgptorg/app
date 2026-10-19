// The package's sources import each other without extensions, like the rest of the repo, which Node's type
// stripping cannot resolve on its own; this lets the generator run on plain Node without a build step.
import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, nextResolve) {
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            if (!specifier.startsWith('.') || specifier.endsWith('.ts')) throw error;
            return nextResolve(`${specifier}.ts`, context);
        }
    },
});
