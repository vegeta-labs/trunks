-- E2: classification and field extraction (tech design §4). 001_e1.sql is released and frozen (tech design §7).

CREATE TABLE case_label (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  generation integer NOT NULL, -- processing generation that produced it; person labels: the generation they were added at
  class_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('model', 'rule', 'person')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'rule', 'person')),
  adopted boolean NOT NULL, -- C-CLS-2: model high / medium, rule and person labels; model low labels count for risk only
  reason_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  created_by uuid REFERENCES app_user ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, generation, class_id, source)
);

CREATE TABLE case_field (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  generation integer NOT NULL,
  field text NOT NULL,
  value_blob uuid REFERENCES secret_blob ON DELETE RESTRICT, -- null when void or empty
  confidence text CHECK (confidence IN ('high', 'medium', 'low', 'rule')),
  source text NOT NULL CHECK (source IN ('model', 'rule', 'merged')),
  provenance_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ok', 'void', 'multiple', 'conflict')),
  needs_confirmation boolean NOT NULL, -- C-FLD-2: low confidence or failed validation
  confirmed_by uuid REFERENCES app_user ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, generation, field)
);

-- every model reply, valid or not, saved as soon as it arrives: a retried pipeline step reuses it and does not call
-- the model again (PRD C-FLD-0, TC-FLD-07)
CREATE TABLE model_output (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  prompt_version text NOT NULL,
  model_id text NOT NULL,
  input_sha256 text NOT NULL,
  attempt integer NOT NULL CHECK (attempt IN (1, 2)),
  raw_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  error text, -- null when the reply validated
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, prompt_version, model_id, input_sha256, attempt)
);

REVOKE ALL ON case_label, case_field, model_output FROM PUBLIC;
GRANT SELECT ON case_label, case_field, model_output TO doi_app, doi_maintenance;
GRANT INSERT, UPDATE ON case_label, case_field TO doi_app;
GRANT INSERT ON model_output TO doi_app;
