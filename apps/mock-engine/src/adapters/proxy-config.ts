import type { Secret } from '../domain/secret';

export interface ProxyCredentials {
    /** Percent-decoded from the proxy URL. */
    readonly username: string;
    readonly password: Secret;
}

/**
 * One `NO_PROXY` entry. `host` is lowercased without a leading dot and matches itself and its subdomains; `*`
 * matches every host. IPv6 entries are stored without brackets. `port: null` matches any port.
 */
export interface NoProxyRule {
    readonly host: string;
    readonly port: number | null;
}

/** An `http://` proxy from `HTTPS_PROXY`, reached with `CONNECT`. */
export interface ProxyConfig {
    /** Hostname or IP address; IPv6 without brackets. */
    readonly host: string;
    readonly port: number;
    readonly credentials: ProxyCredentials | null;
    readonly noProxy: readonly NoProxyRule[];
}
