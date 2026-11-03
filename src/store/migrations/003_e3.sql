-- E3: linking, risk, replies, verification tasks, routing, events (tech design §4, v0.7.4). 001 and 002 are released
-- and frozen (tech design §7). Every text value lives in secret_blob (PRD R-PRV-05).

-- routing (R-RTE) and the source of the risk and queue
ALTER TABLE "case"
  ADD COLUMN risk_by text CHECK (risk_by IN ('system', 'person')),
  ADD COLUMN queue_by text CHECK (queue_by IN ('system', 'person')),
  ADD COLUMN follow_up_at timestamptz,
  ADD COLUMN generation_by text NOT NULL DEFAULT 'system' CHECK (generation_by IN ('system', 'person')), -- who started the current generation (appendix A `by`)
  ADD COLUMN risk_hold text CHECK (risk_hold IN ('low', 'medium', 'high')); -- PRD C-RSK-3 v0.7.15: the risk before a person's change, kept until an approver confirms a lower one

-- a person's label changes (C-CLS-5): the effective labels are the classify step's plus these, in order
CREATE TABLE case_label_change (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  class_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('add', 'remove')),
  by_user uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  reason_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_label_change_case ON case_label_change (case_id, created_at);

-- a person's field values and confirmations (R-REV-03, C-DRF-1 «经人确认»): the latest row per field wins
CREATE TABLE case_field_change (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  field text NOT NULL,
  value_blob uuid REFERENCES secret_blob ON DELETE RESTRICT, -- {"value": …} or null for «empty»
  by_user uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_field_change_case ON case_field_change (case_id, field, created_at);

-- links (C-LNK): automatic ones per processing generation, a person's ones without a generation (they override)
CREATE TABLE case_link (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  generation int, -- null for a person's link
  kind text NOT NULL CHECK (kind IN ('contact', 'commitment', 'deal', 'bank_line')),
  target_blob uuid REFERENCES secret_blob ON DELETE RESTRICT, -- null: a person cleared this kind
  source text NOT NULL CHECK (source IN ('auto', 'person')),
  by_user uuid REFERENCES app_user ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true, -- a person's link is replaced by their next one for the kind
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_link_case ON case_link (case_id, generation);

-- PRD C-RSK-3 ①–⑦ (v0.7.12)
CREATE TABLE risk_adjustment (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  level text NOT NULL CHECK (level IN ('low', 'medium', 'high')),
  computed_at_set text NOT NULL CHECK (computed_at_set IN ('low', 'medium', 'high')),
  reasons jsonb NOT NULL, -- R0: class ids and clause ids
  state text NOT NULL CHECK (state IN ('active', 'replaced', 'cancelled', 'void')),
  by_user uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  reason_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE UNIQUE INDEX risk_adjustment_one_active ON risk_adjustment (case_id) WHERE state = 'active';

-- replies (C-DRF): generated per generation, or edited / chosen by a person; approval binds C-DRF-8
CREATE TABLE reply (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  generation int NOT NULL,
  template_id text NOT NULL,
  template_source text NOT NULL CHECK (template_source IN ('auto', 'person')),
  edited boolean NOT NULL DEFAULT false, -- a person changed the text: never overwritten by a re-run (tech design §6)
  recipient_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  subject_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  text_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  content_sha256 text NOT NULL,
  removed_sentences int NOT NULL DEFAULT 0,
  check_ok boolean NOT NULL,
  check_problems jsonb NOT NULL DEFAULT '[]', -- codes and internal terms only (no personal data)
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'sent', 'superseded', 'rejected')),
  created_by uuid REFERENCES app_user ON DELETE RESTRICT,
  approved_by uuid REFERENCES app_user ON DELETE RESTRICT,
  approved_at timestamptz,
  approved_generation int,
  approved_manual_revision int,
  sent_by uuid REFERENCES app_user ON DELETE RESTRICT,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reply_case ON reply (case_id, created_at);

-- C-FRD-4, C-FRD-5
CREATE TABLE verification_task (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('bank_details', 'identity_change')),
  state text NOT NULL CHECK (state IN ('open', 'checklist_done', 'approved', 'invalidated')),
  bound_manual_revision int NOT NULL,
  bound_contact_blob uuid REFERENCES secret_blob ON DELETE RESTRICT, -- the linked contact id, or null
  checklist jsonb NOT NULL, -- item ids, in order
  checked jsonb NOT NULL DEFAULT '[]', -- item ids ticked
  phone_blob uuid REFERENCES secret_blob ON DELETE RESTRICT, -- from the contacts CSV only; null: none on file
  notify_recipient_blob uuid REFERENCES secret_blob ON DELETE RESTRICT, -- the contact's address on file
  notify_subject_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  notify_text_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  notify_problems jsonb NOT NULL DEFAULT '[]', -- C-DRF-2 ② / ④ b on the rendered notice: codes and internal terms only
  completed_by uuid REFERENCES app_user ON DELETE RESTRICT,
  completed_at timestamptz,
  cooling_until timestamptz,
  approved_by uuid REFERENCES app_user ON DELETE RESTRICT,
  approved_at timestamptz,
  invalidated_at timestamptz,
  replaced_by uuid REFERENCES verification_task ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR completed_by IS NULL OR approved_by <> completed_by)
);
CREATE INDEX verification_task_case ON verification_task (case_id);

-- C-OUT-1
CREATE TABLE event_outbox (
  id text PRIMARY KEY, -- HMAC(deployment key, case_id + case_event_seq)
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  case_event_seq int NOT NULL,
  type text NOT NULL,
  event_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'blocked', 'unsent')), -- unsent: no webhook configured
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (case_id, case_event_seq)
);
CREATE INDEX event_outbox_due ON event_outbox (status, next_attempt_at);

CREATE TABLE event_state (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  type text NOT NULL,
  care_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT, -- the value last sent (C-OUT-1)
  care_sha256 text NOT NULL,
  PRIMARY KEY (case_id, type)
);

REVOKE ALL ON case_label_change, case_field_change, case_link, risk_adjustment, reply, verification_task, event_outbox, event_state FROM PUBLIC;
GRANT SELECT ON case_label_change, case_field_change, case_link, risk_adjustment, reply, verification_task, event_outbox, event_state TO doi_app, doi_maintenance;
GRANT INSERT ON case_label_change, case_field_change, case_link, risk_adjustment, reply, verification_task, event_outbox, event_state TO doi_app;
GRANT UPDATE ON case_link, reply, verification_task, event_state TO doi_app;
GRANT UPDATE (state, ended_at) ON risk_adjustment TO doi_app;
GRANT UPDATE (status, attempts, next_attempt_at, last_error, sent_at) ON event_outbox TO doi_app;
