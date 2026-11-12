-- The database roles are now trunks_app, trunks_maintenance and trunks_rotation (before: doi_*). The roles
-- themselves are renamed by `migrate` before any migration runs, so grants and ownership follow. Two places hold a
-- role name as text and are brought in line here. On a database created after the rename both statements change
-- nothing.

DROP POLICY intent_delete_own ON file_write_intent;
CREATE POLICY intent_delete_own ON file_write_intent FOR DELETE USING (created_by_role = current_user OR current_user = 'trunks_maintenance');

UPDATE file_write_intent SET created_by_role = 'trunks_' || substr(created_by_role, 5)
  WHERE created_by_role IN ('doi_app', 'doi_maintenance', 'doi_rotation');
