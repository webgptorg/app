/**
 * What a saved login is called in its row. The engine names a login after its site and masked account
 * (`github.com · ad…@example.com`), which would repeat the site and the username beside it, so such a name shows as the
 * site alone. A name the owner gave it (`Work GitHub`) leads, and the site follows it once, in `site`.
 */
export function loginTitle(label: string, site: string): { readonly title: string; readonly site: string | null } {
    const derived = label === site || label.startsWith(`${site} `);
    return derived ? { title: site, site: null } : { title: label, site };
}
