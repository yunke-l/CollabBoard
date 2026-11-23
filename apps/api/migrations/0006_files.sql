CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  uploader_id uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL UNIQUE,
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 120),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'rejected', 'deleted', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  version integer NOT NULL DEFAULT 1,
  object_removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);
CREATE INDEX attachments_task_idx ON attachments(task_id, created_at DESC, id DESC);
CREATE INDEX attachments_quota_idx ON attachments(project_id, state, expires_at);
