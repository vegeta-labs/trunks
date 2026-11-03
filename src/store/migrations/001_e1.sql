-- E1 schema (tech design §4, §4.1). Run by the owner role. Only ids, enums, hashes, times, integer amounts and
-- booleans are stored in logical tables; every text value lives in secret_blob (PRD R-PRV-05).

CREATE TABLE secret_blob (
  id uuid PRIMARY KEY,
  key_id text NOT NULL,
  wrapped_dek bytea NOT NULL,
  ciphertext bytea NOT NULL,
  content_hmac text NOT NULL, -- HMAC-SHA256(deployment key, plaintext): unchanged by key rotation
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mailbox (
  id text PRIMARY KEY, -- configured internal id; does not change when the mailbox is renamed
  name_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('imap', 'gmail', 'graph', 'eml', 'eval')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mailbox_cursor (
  mailbox_id text PRIMARY KEY REFERENCES mailbox ON DELETE RESTRICT,
  cursor_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- directory (R-DIR, C-LNK-0) ----------

CREATE TABLE directory_version (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('deals', 'contacts', 'commitments', 'bank', 'ledger')),
  deal_key text, -- HMAC of the deal name; set for per-deal kinds
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid NOT NULL,
  file_sha256 text NOT NULL,
  CHECK ((kind IN ('deals', 'contacts')) = (deal_key IS NULL))
);

CREATE TABLE deal (
  id uuid PRIMARY KEY,
  directory_version uuid NOT NULL REFERENCES directory_version ON DELETE RESTRICT,
  deal_key text NOT NULL, -- HMAC(name), stable across versions
  name_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  close_date date,
  reference_prefix_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  row_no int NOT NULL,
  UNIQUE (directory_version, deal_key)
);

CREATE TABLE commitment (
  id uuid PRIMARY KEY,
  directory_version uuid NOT NULL REFERENCES directory_version ON DELETE RESTRICT,
  deal_key text NOT NULL,
  commitment_key_hmac text NOT NULL, -- HMAC("deal name::investor_id")
  investor_id_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  name_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  email_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  reference_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  cash_due_minor bigint NOT NULL CHECK (cash_due_minor >= 0),
  scheme_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  row_no int NOT NULL,
  UNIQUE (directory_version, commitment_key_hmac)
);

CREATE TABLE bank_line (
  id uuid PRIMARY KEY,
  directory_version uuid NOT NULL REFERENCES directory_version ON DELETE RESTRICT,
  deal_key text NOT NULL,
  txn_id_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  value_date date NOT NULL,
  amount_minor bigint NOT NULL,
  payer_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  reference_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  row_no int NOT NULL
);

CREATE TABLE ledger_line (
  id uuid PRIMARY KEY,
  directory_version uuid NOT NULL REFERENCES directory_version ON DELETE RESTRICT,
  deal_key text NOT NULL,
  txn_id_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  value_date date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  payer_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  reference_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('auto', 'confirmed', 'suggested', 'unmatched', 'rejected', 'skipped', 'future')), -- Toolkit LineStatus
  commitment_key_hmac text,
  investor_name_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  decided_by_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  withdrawn_on date,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  row_no int NOT NULL
);

CREATE TABLE contact (
  id uuid PRIMARY KEY,
  directory_version uuid NOT NULL REFERENCES directory_version ON DELETE RESTRICT,
  contact_key_hmac text NOT NULL, -- HMAC(contact_id)
  contact_id_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  name_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  emails_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  phone_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('investor', 'lead', 'company', 'seller', 'adviser', 'other')),
  deals_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  investor_ids_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  authorised_for_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  row_no int NOT NULL,
  UNIQUE (directory_version, contact_key_hmac)
);

CREATE TABLE contact_email (
  contact uuid NOT NULL REFERENCES contact ON DELETE RESTRICT,
  email_hmac text NOT NULL, -- HMAC of the I-03 normalised address
  PRIMARY KEY (contact, email_hmac)
);
CREATE INDEX contact_email_hmac ON contact_email (email_hmac);

CREATE TABLE directory_snapshot (
  id uuid PRIMARY KEY,
  deals_version uuid REFERENCES directory_version ON DELETE RESTRICT,
  contacts_version uuid REFERENCES directory_version ON DELETE RESTRICT,
  per_deal jsonb NOT NULL, -- {deal_key: {commitment, bank, ledger}} version ids or null
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- mail ----------

CREATE TABLE message (
  id uuid PRIMARY KEY,
  mailbox_id text NOT NULL REFERENCES mailbox ON DELETE RESTRICT,
  dedupe_key_hmac text NOT NULL,
  received_at timestamptz NOT NULL, -- adapter server time (C-SIG-2)
  ingested_at timestamptz NOT NULL DEFAULT now(),
  observed_seq bigint NOT NULL, -- order in which the deployment observed the message (C-SIG-1.6)
  from_addr_hmac text,
  message_id_hmac text,
  header_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  thread_id uuid NOT NULL,
  raw_sha256 text NOT NULL,
  raw_sans_msgid_sha256 text NOT NULL,
  collision boolean NOT NULL,
  UNIQUE (mailbox_id, dedupe_key_hmac, raw_sans_msgid_sha256),
  UNIQUE (observed_seq)
);
CREATE INDEX message_from ON message (from_addr_hmac);
CREATE INDEX message_msgid ON message (message_id_hmac);

CREATE TABLE message_file (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('original', 'kyc_stripped')),
  sha256 text NOT NULL,
  file_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attachment (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message ON DELETE RESTRICT,
  parent_id uuid REFERENCES attachment ON DELETE RESTRICT, -- part of a nested .eml
  ordinal int NOT NULL,
  depth int NOT NULL,
  name_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('pdf', 'txt', 'csv', 'eml', 'docx', 'xml', 'image', 'other')),
  size bigint NOT NULL,
  sha256 text NOT NULL,
  file_ref text,
  -- mutable status columns (tech design §4.1)
  scan_status text NOT NULL CHECK (scan_status IN ('pending', 'clean', 'infected', 'error', 'skipped')),
  parse_status text NOT NULL CHECK (parse_status IN ('pending', 'parsed', 'not_parsed', 'over_limit', 'failed', 'timeout', 'blocked')),
  maybe_kyc boolean,
  source_deleted boolean NOT NULL DEFAULT false,
  UNIQUE (message_id, ordinal)
);

CREATE TABLE attachment_text (
  attachment_id uuid PRIMARY KEY REFERENCES attachment ON DELETE RESTRICT,
  text_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  facts_blob uuid REFERENCES secret_blob ON DELETE RESTRICT -- parser facts (pages without text, pacs.008 items)
);

CREATE TABLE "case" (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE REFERENCES message ON DELETE RESTRICT,
  previous_case_id uuid REFERENCES "case" ON DELETE RESTRICT, -- same thread (C-ING-3)
  manual_revision int NOT NULL DEFAULT 0,
  system_revision int NOT NULL DEFAULT 0,
  processing_generation int NOT NULL DEFAULT 1,
  pipeline_complete_generation int,
  status text NOT NULL CHECK (status IN ('processing', 'open', 'failed', 'approved', 'sent', 'closed')),
  failed_stage text,
  flags text[] NOT NULL DEFAULT '{}', -- e.g. attachment_blocked, attachment_over_limit, mime_parse_failed
  risk text CHECK (risk IN ('low', 'medium', 'high')),
  queue text,
  assignee uuid,
  due_at timestamptz,
  closed_at timestamptz,
  outcome text CHECK (outcome IN ('replied', 'no_action', 'forwarded', 'duplicate', 'spam')),
  hold boolean NOT NULL DEFAULT false,
  snapshot_id uuid NOT NULL REFERENCES directory_snapshot ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stage_run (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  stage text NOT NULL,
  generation int NOT NULL,
  input_identity text NOT NULL,
  result_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  reused boolean NOT NULL DEFAULT false, -- the result was taken over from an earlier generation with the same input
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, stage, generation) -- one result per stage and generation
);
CREATE INDEX stage_run_identity ON stage_run (case_id, stage, input_identity);

CREATE TABLE case_signal (
  case_id uuid NOT NULL REFERENCES "case" ON DELETE RESTRICT,
  signal text NOT NULL,
  value boolean, -- null = unknown (auth not adopted)
  detail_blob uuid REFERENCES secret_blob ON DELETE RESTRICT,
  batch text NOT NULL CHECK (batch IN ('metadata', 'content')),
  input_sha256 text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, signal)
);

CREATE TABLE redaction_map (
  message_id uuid NOT NULL REFERENCES message ON DELETE RESTRICT,
  placeholder text NOT NULL CHECK (placeholder ~ '^\[[A-Z]+_[0-9]+\]$'),
  value_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  source_attachment_id uuid REFERENCES attachment ON DELETE RESTRICT,
  PRIMARY KEY (message_id, placeholder)
);

-- ---------- users (R-REV-05, R-REV-06) ----------

CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  username_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  username_hmac text NOT NULL UNIQUE,
  password_hash text, -- argon2id; null for OIDC-only users
  must_change_password boolean NOT NULL DEFAULT false,
  credential_version int NOT NULL DEFAULT 1, -- raised by every password change or reset; sessions carry it (Codex F12)
  role text NOT NULL CHECK (role IN ('reviewer', 'approver', 'admin')),
  oidc_sub_hmac text UNIQUE,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_event (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('created', 'role_granted', 'role_removed', 'credential_reset', 'disabled')),
  role text,
  by_user uuid REFERENCES app_user ON DELETE RESTRICT,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_session (
  id_hmac text PRIMARY KEY, -- HMAC of the session token; the token itself is only in the cookie
  user_id uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  csrf_hmac text NOT NULL,
  credential_version int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- ---------- audit (C-AUD) ----------

CREATE TABLE audit (
  seq bigint NOT NULL UNIQUE CHECK (seq >= 1),
  time text NOT NULL, -- exactly the hashed ISO 8601 string
  actor text NOT NULL,
  type text NOT NULL,
  case_id uuid, -- no foreign key (audit rows outlive cases)
  payload jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL
);

CREATE TABLE audit_detail (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL,
  case_id uuid,
  content_blob uuid NOT NULL REFERENCES secret_blob ON DELETE RESTRICT,
  source_attachment_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- one row per owning Case: retention and KYC replacement of one Case never touch another's (self-test LK-F4)
  UNIQUE NULLS NOT DISTINCT (sha256, case_id)
);

CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit rows cannot be changed or deleted (C-AUD-2)';
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

-- ---------- files ----------

CREATE TABLE file_write_intent (
  id uuid PRIMARY KEY,
  object_key text NOT NULL,
  purpose text NOT NULL,
  created_by_role text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- grants (tech design §4.1) ----------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO doi_app, doi_maintenance;
GRANT INSERT ON mailbox, mailbox_cursor, message, message_file, attachment, attachment_text, file_write_intent,
  directory_version, directory_snapshot, deal, commitment, bank_line, ledger_line, contact, contact_email, "case",
  stage_run, case_signal, redaction_map, user_event, app_user, app_session, secret_blob, audit, audit_detail TO doi_app;
GRANT UPDATE ON "case", mailbox_cursor, app_user TO doi_app;
GRANT UPDATE (scan_status, parse_status, maybe_kyc) ON attachment TO doi_app;
GRANT UPDATE (credential_version) ON app_session TO doi_app; -- the session that changed the password stays valid
GRANT DELETE ON file_write_intent, app_session TO doi_app;
-- maintenance: E1 needs only the audit and file-intent parts; retention and KYC grants arrive with E4
GRANT INSERT ON audit, audit_detail, file_write_intent, secret_blob TO doi_maintenance;
GRANT DELETE ON file_write_intent TO doi_maintenance;
GRANT SELECT ON secret_blob, message_file, attachment TO doi_rotation;
GRANT UPDATE (key_id, wrapped_dek) ON secret_blob TO doi_rotation;

-- app may delete only its own file intents (tech design §4)
ALTER TABLE file_write_intent ENABLE ROW LEVEL SECURITY;
CREATE POLICY intent_read ON file_write_intent FOR SELECT USING (true);
CREATE POLICY intent_insert ON file_write_intent FOR INSERT WITH CHECK (created_by_role = current_user);
CREATE POLICY intent_delete_own ON file_write_intent FOR DELETE USING (created_by_role = current_user OR current_user = 'doi_maintenance');

-- pg-boss queue tables live in their own schema, owned by the app role
CREATE SCHEMA pgboss AUTHORIZATION doi_app;
