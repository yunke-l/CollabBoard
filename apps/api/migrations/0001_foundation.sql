CREATE TABLE users (
  id uuid PRIMARY KEY,
  identity_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'expired')),
  board_revision integer NOT NULL DEFAULT 0 CHECK (board_revision >= 0),
  is_trial boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_trial OR expires_at IS NOT NULL)
);
CREATE INDEX projects_owner_idx ON projects(owner_id, status);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('Owner', 'Editor', 'Viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE UNIQUE INDEX project_single_owner_idx ON project_members(project_id) WHERE role = 'Owner';
CREATE INDEX project_members_user_idx ON project_members(user_id, project_id);

CREATE FUNCTION enforce_project_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN target_id := COALESCE(NEW.id, OLD.id);
  ELSE target_id := COALESCE(NEW.project_id, OLD.project_id); END IF;
  IF EXISTS (
    SELECT 1 FROM projects p WHERE p.id = target_id AND NOT EXISTS (
      SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = p.owner_id AND m.role = 'Owner'
    )
  ) THEN RAISE EXCEPTION 'Project ownership must match its Owner membership'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER project_owner_consistency AFTER INSERT OR UPDATE ON projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_project_owner();
CREATE CONSTRAINT TRIGGER member_owner_consistency AFTER INSERT OR UPDATE OR DELETE ON project_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_project_owner();

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  position integer NOT NULL CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  assignee_id uuid REFERENCES users(id),
  due_date date,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX tasks_active_position_idx ON tasks(project_id, status, position) WHERE archived_at IS NULL;
CREATE INDEX tasks_project_idx ON tasks(project_id, archived_at, created_at, id);

CREATE TABLE activity (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  change_summary jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id)
);
CREATE INDEX activity_project_idx ON activity(project_id, created_at DESC, id DESC);

CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  entity_version integer NOT NULL,
  board_revision integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events(created_at) WHERE state = 'pending';

CREATE TABLE idempotency_records (
  user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, operation, request_id)
);
CREATE INDEX idempotency_expiration_idx ON idempotency_records(expires_at);
