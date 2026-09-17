# Legacy Whop mapping data retirement

The application no longer reads or writes the `whop_memberships` table. Its
Drizzle schema has been removed, but this cleanup intentionally does **not**
drop the physical table. Removing production data must be a separate,
reviewed database operation.

## Migration sequence

1. **Inventory**
   - Confirm the application has been running on Stripe-only billing for the
     agreed observation period.
   - Record the row count and the newest `last_checked_at`, `verified_at`, and
     `current_period_end` values.
   - Confirm no deployed application version, reporting job, or support tool
     still queries `whop_memberships`.

2. **Archive**
   - Export the complete table to encrypted, access-controlled storage.
   - Record the export timestamp, row count, checksum, retention owner, and
     deletion date.
   - Restore the export into a disposable database and verify its row count
     and checksum before continuing.

3. **Quarantine**
   - Revoke application-role access to the table, or rename it to
     `whop_memberships_retired`, during a maintenance window.
   - Monitor application and database errors through the rollback window.
   - If an unknown dependency appears, restore the original name or grants and
     investigate before attempting retirement again.

4. **Drop**
   - After the rollback window and required retention period have elapsed,
     approve and run a dedicated migration that drops the quarantined table.
   - Do not use `drizzle-kit push --force` to perform this retirement.
   - Verify backups and archive retention after the migration.

## Example read-only inventory

Run against the intended environment before any rename or drop:

```sql
SELECT
  count(*) AS row_count,
  max(last_checked_at) AS newest_check,
  max(verified_at) AS newest_verification,
  max(current_period_end) AS latest_entitlement_end
FROM whop_memberships;
```

The rename, grant changes, and final drop are deliberately omitted here:
their exact SQL must be reviewed against the target environment, active
database roles, backup policy, and agreed retention dates.