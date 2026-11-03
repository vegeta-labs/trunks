-- E4 schema (tech design v0.7.9; PRD v0.7.18): mailbox credentials and per-folder cursors, retention, KYC transfer and
-- replacement, key rotation. Run by the owner role.

-- ---------- mailboxes (PRD C-ING-6, decision 6) ----------

-- one cursor per configured folder (Graph); IMAP and Gmail keep a single cursor with folder_key ''
ALTER TABLE mailbox_cursor ADD COLUMN folder_key text NOT NULL DEFAULT '';
ALTER TABLE mailbox_cursor DROP CONSTRAINT mailbox_cursor_pkey;
ALTER TABLE mailbox_cursor ADD PRIMARY KEY (mailbox_id, folder_key);

-- Gmail refresh tokens only (M365 credentials stay in secret files); kept by retention: it belongs to the mailbox
CREATE TABLE mailbox_credential (
  mailbox_id text PRIMARY KEY REFERENCES mailbox ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('gmail_refresh_token')),
  secret_blob_id uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- retention (PRD C-PRV-1, R-REV-07) ----------

ALTER TABLE "case" ADD COLUMN hold_reason_blob uuid REFERENCES secret_blob ON DELETE RESTRICT;
CREATE INDEX case_previous ON "case" (previous_case_id) WHERE previous_case_id IS NOT NULL;

-- previous_case_id may only be cleared (retention of the earlier message, C-ING-3); column grants cannot say «only null»
CREATE FUNCTION case_previous_clear_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.previous_case_id IS DISTINCT FROM OLD.previous_case_id AND NEW.previous_case_id IS NOT NULL THEN
    RAISE EXCEPTION 'previous_case_id can only be cleared (C-ING-3)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_previous_clear_only BEFORE UPDATE OF previous_case_id ON "case"
  FOR EACH ROW EXECUTE FUNCTION case_previous_clear_only();

-- the day the daily job first found a version unreferenced by any snapshot (cleared when referenced again)
ALTER TABLE directory_version ADD COLUMN unreferenced_since date;

-- files are deleted after the database transaction commits; a job row survives a crash and is retried
CREATE TABLE file_deletion_job (
  id uuid PRIMARY KEY,
  object_key text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('retention', 'kyc')),
  attempts int NOT NULL DEFAULT 0,
  last_error text CHECK (last_error ~ '^[a-z_]{1,40}$'), -- an error code, never a message with data in it
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_deletion_job_key ON file_deletion_job (object_key);
CREATE INDEX file_deletion_job_due ON file_deletion_job (next_attempt_at);

-- ---------- KYC (PRD R-PRV-03, C-PRV-2) ----------

CREATE TABLE kyc_delivery (
  id uuid PRIMARY KEY, -- also the idempotency key sent to the target
  attachment_id uuid NOT NULL UNIQUE REFERENCES attachment ON DELETE RESTRICT, -- one transfer per attachment
  message_id uuid NOT NULL REFERENCES message ON DELETE RESTRICT,
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  seq int NOT NULL CHECK (seq >= 1), -- the generated file name is <case_id>-<seq>.<ext> (tech design §5)
  sha256 text NOT NULL,
  -- discarded: blocked by the virus scan, never sent; an admin marked it handled by hand (PRD R-PRV-03 v0.7.19)
  state text NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'discarded')),
  attempts int NOT NULL DEFAULT 0,
  last_error text CHECK (last_error ~ '^[a-z_0-9]{1,40}$'),
  receipt_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, seq)
);
CREATE INDEX kyc_delivery_message ON kyc_delivery (message_id);

CREATE TABLE kyc_replacement (
  message_id uuid PRIMARY KEY REFERENCES message ON DELETE RESTRICT,
  step int NOT NULL CHECK (step BETWEEN 0 AND 5), -- the last completed step of C-PRV-2 ①–⑤
  original_file_ref text NOT NULL, -- the original MIME object; its message_file row is deleted at step ④
  original_sha256 text NOT NULL,
  stripped_file_ref text,
  stripped_sha256 text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- an undelivered event whose content came before a KYC replacement is withdrawn, not deleted: its sequence number and
-- id are never used again, its content is replaced by a placeholder (PRD C-PRV-2 ④ v0.7.19; Codex E4 round 2 F4)
ALTER TABLE event_outbox DROP CONSTRAINT event_outbox_status_check;
ALTER TABLE event_outbox ADD CONSTRAINT event_outbox_status_check CHECK (status IN ('pending', 'sent', 'failed', 'blocked', 'unsent', 'withdrawn'));
-- the C-OUT-1 value each event carried, so a withdrawal can put event_state back to the last one actually sent
-- (regression review S1); null on a withdrawn event
ALTER TABLE event_outbox ADD COLUMN care_blob uuid REFERENCES secret_blob ON DELETE RESTRICT;
ALTER TABLE event_outbox ADD COLUMN care_sha256 text;

-- ---------- key rotation (PRD R-PRV-05, tech design v0.7.9) ----------

CREATE TABLE key_rotation (
  id uuid PRIMARY KEY,
  from_key text NOT NULL,
  to_key text NOT NULL CHECK (to_key <> from_key),
  started_at timestamptz NOT NULL DEFAULT now(),
  blobs_done bigint NOT NULL DEFAULT 0,
  files_done bigint NOT NULL DEFAULT 0,
  sampled int NOT NULL DEFAULT 0,
  completed_at timestamptz
);

-- ---------- grants (tech design §4.1, v0.7.9) ----------

REVOKE ALL ON mailbox_credential, file_deletion_job, kyc_delivery, kyc_replacement, key_rotation FROM PUBLIC;
GRANT SELECT ON mailbox_credential, file_deletion_job, kyc_delivery, kyc_replacement, key_rotation TO doi_app, doi_maintenance;

-- app
GRANT INSERT, UPDATE ON mailbox_credential TO doi_app;
GRANT INSERT ON kyc_delivery, kyc_replacement TO doi_app; -- key_rotation: only the rotation role writes it (Codex E4 F10)
GRANT UPDATE (state, attempts, last_error, receipt_blob, delivered_at, sha256) ON kyc_delivery TO doi_app;

-- maintenance: retention and KYC
GRANT INSERT ON message_file, file_deletion_job, kyc_replacement, kyc_delivery TO doi_maintenance;
GRANT UPDATE (step, stripped_file_ref, stripped_sha256, finished_at) ON kyc_replacement TO doi_maintenance;
GRANT UPDATE (state, attempts, last_error, receipt_blob, delivered_at) ON kyc_delivery TO doi_maintenance;
GRANT UPDATE (parse_status, maybe_kyc, source_deleted, file_ref) ON attachment TO doi_maintenance;
GRANT UPDATE (previous_case_id) ON "case" TO doi_maintenance; -- the generation moves only through enqueue_kyc_continuation
GRANT UPDATE (status, event_blob, care_blob, care_sha256) ON event_outbox TO doi_maintenance;
GRANT UPDATE (care_blob, care_sha256) ON event_state TO doi_maintenance;
GRANT INSERT ON event_state TO doi_maintenance; -- a baseline rebuilt from delivered events (round 5 F2)
GRANT UPDATE (unreferenced_since) ON directory_version TO doi_maintenance;
GRANT UPDATE (attempts, last_error, next_attempt_at) ON file_deletion_job TO doi_maintenance;
GRANT DELETE ON event_outbox, event_state, reply, risk_adjustment, verification_task, case_label, case_field,
  case_label_change, case_field_change, model_output, model_attempt, case_link, case_signal, stage_run, audit_detail,
  "case", redaction_map, attachment_text, kyc_delivery, kyc_replacement, attachment, message_file, message,
  directory_snapshot, directory_version, deal, commitment, bank_line, ledger_line, contact, contact_email,
  secret_blob, file_deletion_job TO doi_maintenance;

-- rotation
GRANT SELECT ON key_rotation, file_deletion_job, file_write_intent, audit TO doi_rotation;
GRANT INSERT ON key_rotation TO doi_rotation;
GRANT UPDATE (blobs_done, files_done, sampled, completed_at) ON key_rotation TO doi_rotation;

-- ---------- KYC continuation (tech design §4.1: owned by app, SECURITY DEFINER with only app's rights) ----------
-- Called by maintenance in the transaction of C-PRV-2 step ④. It does exactly what a system re-run from `extract` does
-- (restartFrom): the next generation, the earlier stages' results carried over, one `extract` job. Nothing else of
-- the queue is reachable from maintenance.
CREATE FUNCTION enqueue_kyc_continuation(p_case_id uuid, p_generation int) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgboss, pg_temp AS $$
DECLARE
  next_gen int := p_generation + 1;
  from_stage text := 'extract';
  earlier text[] := ARRAY['scan', 'parse', 'content_signals'];
  s text;
BEGIN
  PERFORM 1 FROM public."case" WHERE id = p_case_id AND processing_generation = p_generation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not the current generation of this case';
  END IF;
  UPDATE public."case" SET processing_generation = next_gen, generation_by = 'system',
    status = CASE WHEN status = 'failed' THEN 'processing' ELSE status END, failed_stage = NULL
   WHERE id = p_case_id;
  -- like restartFrom: a stage the current generation has not finished is where the new one starts instead
  FOREACH s IN ARRAY earlier LOOP
    IF NOT EXISTS (SELECT 1 FROM public.stage_run WHERE case_id = p_case_id AND generation = p_generation AND stage = s) THEN
      from_stage := s;
      EXIT;
    END IF;
  END LOOP;
  INSERT INTO public.stage_run (case_id, stage, generation, input_identity, result_blob, reused)
    SELECT case_id, stage, next_gen, input_identity, result_blob, true FROM public.stage_run
     WHERE case_id = p_case_id AND generation = p_generation
       AND stage = ANY (earlier[1:array_position(earlier || 'extract'::text, from_stage) - 1]);
  INSERT INTO pgboss.job (name, data, retry_limit, retry_delay, retry_backoff, singleton_key)
  VALUES (from_stage, jsonb_build_object('caseId', p_case_id, 'generation', next_gen), 3, 5, true,
          p_case_id::text || ':' || from_stage || ':' || next_gen::text);
  RETURN next_gen;
END $$;
ALTER FUNCTION enqueue_kyc_continuation(uuid, int) OWNER TO doi_app;
REVOKE ALL ON FUNCTION enqueue_kyc_continuation(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_kyc_continuation(uuid, int) TO doi_maintenance;
