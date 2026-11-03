-- E2, Codex round 4 F20: every model attempt is reserved, in its own committed transaction, before the request is sent.
-- An attempt reserved but never saved in model_output may have reached the model (the save failed or the worker
-- stopped): a retry counts it as a failed attempt and never sends it again (PRD C-FLD-0, at most two calls per request).
-- 002_e2.sql is released and frozen (tech design §7).

CREATE TABLE model_attempt (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  prompt_version text NOT NULL,
  model_id text NOT NULL,
  input_sha256 text NOT NULL,
  attempt integer NOT NULL CHECK (attempt IN (1, 2)),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, prompt_version, model_id, input_sha256, attempt)
);

REVOKE ALL ON model_attempt FROM PUBLIC;
GRANT SELECT ON model_attempt TO doi_app, doi_maintenance;
-- DELETE only to release a reservation whose request certainly was not sent (a setup error)
GRANT INSERT, DELETE ON model_attempt TO doi_app;
