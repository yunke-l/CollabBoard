CREATE TABLE comments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  body text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE,
  CHECK ((deleted_at IS NULL AND body IS NOT NULL AND char_length(btrim(body)) BETWEEN 1 AND 2000) OR (deleted_at IS NOT NULL AND body IS NULL))
);
CREATE INDEX comments_task_created_idx ON comments(project_id, task_id, created_at DESC, id DESC);
CREATE INDEX comments_task_visible_idx ON comments(task_id) WHERE deleted_at IS NULL;
