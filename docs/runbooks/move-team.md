# Move a team to another organization

When an agency hands a client's team over to the client's own organization (teams spec, "Model"). v1 has no UI for it; a maintainer does it in D1 on the customer's written request. Nothing on the engine changes: its members, data and passkeys stay as they are, and only who pays and who manages people in the dashboard moves.

## Before

1. Get the request in writing from an owner of the **current** organization, naming the team and the target organization. An owner of the target organization confirms they expect it.
2. Find the IDs, from `apps/dashboard`:
   ```sh
   npx wrangler d1 execute DB --env production --remote \
     --command "SELECT t.id, t.org_id, t.name, e.engine_id FROM teams t LEFT JOIN engines e ON e.team_id = t.id WHERE t.deleted_at IS NULL AND t.org_id = '<current org ID>'"
   ```
3. Check the target organization's plan covers one more engine; if not, the customer upgrades first.

## Move

Run both statements in one transaction, so the team and its engine never sit in different organizations:

```sh
npx wrangler d1 execute DB --env production --remote --command "
  UPDATE teams SET org_id = '<target org ID>' WHERE id = '<team ID>' AND org_id = '<current org ID>';
  UPDATE engines SET org_id = '<target org ID>' WHERE team_id = '<team ID>' AND org_id = '<current org ID>';"
```

## After

1. **People.** Team members who are not in the target organization can no longer see the team in the dashboard, but they keep their access on the engine. List them and ask the target organization's owner whether to invite them or to remove them on the engine:
   ```sh
   npx wrangler d1 execute DB --env production --remote \
     --command "SELECT tm.user_id FROM team_members tm WHERE tm.team_id = '<team ID>' AND tm.user_id NOT IN (SELECT user_id FROM memberships WHERE org_id = '<target org ID>')"
   ```
   Then delete those `team_members` rows. Do not queue revocations for them: the new owner decides.
2. **Pending invitations** of the old organization that name the team are left alone; acceptance skips teams of another organization.
3. Write to both owners that the move is done, and record it in the support log with both organization IDs.
