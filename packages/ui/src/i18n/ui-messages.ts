/**
 * Every user-visible string `@ptbk/ui` renders. The package has no catalogue of its own: each app maps its Paraglide
 * messages onto this interface and passes it to `<UiProvider>`, so a missing message is a type error in the app.
 * Messages are functions because Paraglide's are, and they read the current locale when called.
 *
 * Changing this interface is a breaking change for both engine-ui and the dashboard.
 */
export interface UiMessages {
    readonly close: () => string;
    readonly cancel: () => string;
    readonly confirm: () => string;
    readonly loading: () => string;
    readonly retry: () => string;
    readonly errorTitle: () => string;
    readonly errorDetails: () => string;
    readonly dismiss: () => string;
    readonly notifications: () => string;
    readonly copy: () => string;
    readonly copied: () => string;
    readonly copyFailed: () => string;
    readonly opensInNewTab: () => string;
    readonly skipToContent: () => string;
    readonly required: () => string;
    readonly showMore: () => string;
    readonly moreActions: () => string;
    readonly typeToConfirm: (params: { readonly phrase: string }) => string;

    readonly pagination: () => string;
    readonly previousPage: () => string;
    readonly nextPage: () => string;
    readonly totalItems: (params: { readonly count: number }) => string;

    readonly noResults: () => string;
    readonly noData: () => string;
    readonly columns: () => string;
    readonly rowActions: (params: { readonly label: string }) => string;
    readonly selectRow: (params: { readonly label: string }) => string;
    readonly selectAllOnPage: () => string;
    readonly selectedCount: (params: { readonly count: number }) => string;
    readonly expandRow: (params: { readonly label: string }) => string;
    readonly collapseRow: (params: { readonly label: string }) => string;
    readonly sortAscending: () => string;
    readonly sortDescending: () => string;
    readonly sortBy: (params: { readonly column: string }) => string;

    readonly formInvalid: () => string;

    readonly trustMarkVerifying: () => string;
    readonly trustMarkVerified: () => string;
    readonly trustMarkFingerprint: (params: { readonly code: string }) => string;

    readonly engineSwitcher: () => string;
    readonly currentEngine: () => string;
    readonly allEngines: () => string;
    readonly addEngine: () => string;
    readonly engineOnline: () => string;
    readonly engineOffline: () => string;
    readonly engineUnknown: () => string;
}
