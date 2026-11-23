# Website billing

Billing with `ADAPTERS.billing = website` ([ADR 0021](../../../../../../docs/adr/0021-website-license-authority.md), #329): ptbk.io sells and bills, so the dashboard's Billing screen is the licence card with links to the website, and says plainly that a licence is advisory while the server reports `enforcement: advisory`. Prepared, **not routed yet**: `/billing` still redirects to `/license` with website billing and renders the Stripe page otherwise.

| File                       | What                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `website-billing-page.tsx` | `WebsiteBillingPage`: License's status card (`LicenseStatusSection`) with buy, manage and invoices links, then the advisory copy. Reads `GET /api/license`, as License does.          |
| `website-links.ts`         | Pure link building from `WebsiteBillingConfig` and the licence's server-checked `manageUrl`: https on `WEBSITE_ORIGIN` only, nothing from user input.                                 |
| `billing-screen-route.tsx` | `requireBillingScreen(session)` (`beforeLoad`: `website` needs `license.read`, the Checkout needs billing on, else not found) and `BillingScreenPage`, which renders the chosen page. |

## Switching it on

Replace the `beforeLoad` and `component` of `routes/_app/billing.tsx`:

```tsx
beforeLoad: ({ context }) => ({ billingScreen: requireBillingScreen(context.session) }),
component: function Billing() {
    return (
        <BillingScreenPage
            screen={Route.useRouteContext().billingScreen}
            checkout={checkoutReturn(Route.useSearch().checkout)}
        />
    );
},
```

Then decide, with the product owner:

- **Navigation.** The shell names the screen "License" (`/license`) with website billing. Either point "Billing" back at `/billing` and keep `/license` for the grants, or keep one entry.
- **Prefetch.** The route's loader prefetches `billingQuery`; with the website screen prefetch `licenseQuery` instead (the screen is in the guard's result).

## Open points (configuration, not code)

`DEFAULT_WEBSITE_BILLING_CONFIG` holds today's answers; pass another `WebsiteBillingConfig` to `WebsiteBillingPage` to change them.

- **Buy page:** `/cs/pricing/predplatne` for every locale, the page the server's own fallback uses (`WEBSITE_PRICING_PATH` in `app/http/licensing-routes.ts`); `buyPaths` is per locale for when the website has an English one.
- **Plan label:** the website's `display.label` is Czech only, so it shows only in `planLabelLocales` (`cs`); English reads "ptbk.io license".
- **Invoices:** the website has no invoices page to link yet; `invoicesPaths: null` hides the link.
- **Origin:** `websiteOrigin` is production's `https://www.ptbk.io`. The SPA does not receive `WEBSITE_ORIGIN`, so a staging website needs it passed in (for example an additive field on `GET /api/license`); until then a manage link on another origin is dropped, never shown.
