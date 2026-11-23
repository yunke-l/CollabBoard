CREATE UNIQUE INDEX projects_active_trial_owner_idx ON projects(owner_id) WHERE is_trial AND status = 'active';
CREATE TABLE rate_limits (
  subject text NOT NULL,
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  used integer NOT NULL,
  PRIMARY KEY(subject, bucket, window_start)
);
CREATE TABLE object_cleanup (
  object_key text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
