ALTER TABLE outbox_events ADD COLUMN recipients_initialized boolean NOT NULL DEFAULT false;
CREATE TABLE event_deliveries (
  event_id uuid NOT NULL REFERENCES outbox_events(event_id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  first_failure_at timestamptz,
  delivered_at timestamptz,
  PRIMARY KEY (event_id, recipient_id)
);
CREATE INDEX event_delivery_pending_idx ON event_deliveries(next_attempt_at) WHERE state = 'pending';
