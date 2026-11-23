CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES users(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  type text NOT NULL CHECK (type = 'task_assigned'),
  source_event_id uuid NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, source_event_id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_recipient_created_idx ON notifications(recipient_id, created_at DESC, id DESC);
CREATE INDEX notifications_recipient_unread_idx ON notifications(recipient_id) WHERE read_at IS NULL;
