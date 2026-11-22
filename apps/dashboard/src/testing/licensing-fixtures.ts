import { randomAlphanumeric } from './billing-fixtures';

/** Generated per run, so no credential-shaped literal sits in the repo for a scanner to flag. */
export function syntheticLicenseSecret(): string {
    return randomAlphanumeric(48);
}
