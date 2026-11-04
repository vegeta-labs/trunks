-- E6 (tech design v0.7.16).

-- Failure reasons (E6 D2): a fixed code per failed Case; the error's own text stays only in the encrypted audit detail.
ALTER TABLE "case" ADD COLUMN failed_reason text
  CHECK (failed_reason IN ('model_setup', 'replay_missing', 'parser_unavailable', 'scanner_unavailable', 'storage_error', 'database_error', 'internal'));

-- the KYC continuation clears the reason with the failed step (same SECURITY DEFINER and search_path as in 004)
CREATE OR REPLACE FUNCTION enqueue_kyc_continuation(p_case_id uuid, p_generation int) RETURNS int
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
    status = CASE WHEN status = 'failed' THEN 'processing' ELSE status END, failed_stage = NULL, failed_reason = NULL
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

-- error text and stacks pg-boss stored for failed or retried jobs before E6 may hold values from an email
DO $$
BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'UPDATE pgboss.job SET output = NULL WHERE output IS NOT NULL';
  END IF;
END $$;

-- B.1–4 metadata is recorded at ingest; image structure is inspected once, at the first KYC judgement.
ALTER TABLE message ADD COLUMN mime_version smallint NOT NULL DEFAULT 1 CHECK (mime_version IN (1, 2));
ALTER TABLE attachment ADD COLUMN content_id_hmac text,
  ADD COLUMN disposition text CHECK (disposition IN ('inline', 'attachment', 'other')),
  ADD COLUMN html_referenced boolean,
  ADD COLUMN inline_eligible boolean,
  ADD COLUMN image_facts jsonb,
  ADD COLUMN kyc_reason text,
  ADD COLUMN kyc_recheck_pending boolean NOT NULL DEFAULT false;
GRANT UPDATE (content_id_hmac, disposition, html_referenced, inline_eligible, image_facts, kyc_reason, kyc_recheck_pending) ON attachment TO doi_app;

ALTER TABLE kyc_replacement ADD COLUMN round int NOT NULL DEFAULT 1 CHECK (round > 0);
ALTER TABLE kyc_replacement DROP CONSTRAINT kyc_replacement_pkey;
ALTER TABLE kyc_replacement ADD PRIMARY KEY (message_id, round);
CREATE UNIQUE INDEX kyc_replacement_in_progress ON kyc_replacement (message_id) WHERE step < 5;
