-- Preserve project IDs, memberships, tasks and files. Previously withdrawn
-- copies stay inaccessible under their existing status.
UPDATE projects SET description = ''
WHERE is_trial AND description = 'An isolated seven-day trial. All changes belong to this project.';
SET CONSTRAINTS project_owner_consistency IMMEDIATE;
DROP INDEX projects_active_trial_owner_idx;
ALTER TABLE projects DROP COLUMN is_trial, DROP COLUMN expires_at;
