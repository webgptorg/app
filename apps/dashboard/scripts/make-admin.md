# Granting the platform admin role

No screen or API grants `platform_role = 'admin'`; an operator with D1 access sets it directly, for an account that already exists. Platform admin actions still need a passkey step-up within the last 5 minutes, and every one of them is written to `admin_audit_log`.

```sh
cd apps/dashboard
# --env staging or --env production; --local for the dev database
npx wrangler d1 execute DB --env production --remote \
  --command "UPDATE users SET platform_role = 'admin' WHERE email = lower('person@example.com')"
```

Check that exactly one row changed (`changes: 1` in the output). To revoke the role, run the same command with `platform_role = 'none'`. The person's sessions pick up the change on their next request; nobody needs to sign in again.
