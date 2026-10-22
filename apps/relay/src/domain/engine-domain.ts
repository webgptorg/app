/** `name` is `domain` or a name under it. Both are compared as given: hostname schemas leave them lowercase. */
export function isWithinDomain(name: string, domain: string): boolean {
    return name === domain || name.endsWith(`.${domain}`);
}

/**
 * Whether a certificate name (a DNS SAN or the subject CN) is valid for `domain` or any name under it. A wildcard
 * anywhere in the leftmost label stands for any label, as TLS clients that accept partial wildcards read it, so
 * `*.test` and `e*.test` cover `engine.test` while `*.example` covers neither it nor its names.
 */
export function certificateNameCovers(certificateName: string, domain: string): boolean {
    const name = certificateName.toLowerCase().replace(/\.$/, '');
    if (isWithinDomain(name, domain)) return true;
    const dot = name.indexOf('.');
    if (dot === -1) return name.includes('*');
    if (!name.slice(0, dot).includes('*')) return false;
    const parent = name.slice(dot + 1);
    return domain.endsWith(`.${parent}`) && !domain.slice(0, -(parent.length + 1)).includes('.');
}
