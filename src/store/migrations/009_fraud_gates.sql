-- Fraud gates (PRD v0.7.30, tech design v0.7.19, plan docs/11_FRAUD_GATES_PLAN.md).

-- C-FRD-6: who approved a removal of a protected class. A removal counts only when this is set.
ALTER TABLE case_label_change ADD COLUMN approved_by uuid REFERENCES app_user ON DELETE RESTRICT;
-- Backfill conservatively: an older removal of a protected class counts only when its author is an approver or admin
-- today, has had no role change since the removal, and gave a reason.
UPDATE case_label_change l SET approved_by = l.by_user
  FROM app_user u
 WHERE u.id = l.by_user AND l.action = 'remove' AND l.reason_blob IS NOT NULL
   AND l.class_id IN ('bank_details', 'identity_change') AND u.role IN ('approver', 'admin')
   AND NOT EXISTS (SELECT 1 FROM user_event e WHERE e.user_id = u.id AND e.type IN ('role_granted', 'role_removed') AND e.at > l.created_at);

-- C-DRF-11: everyone who has changed the text of a reply; pre-existing replies count every person who created any reply
-- on that Case, in any generation (a template switch starts a new generation and keeps the earlier text).
ALTER TABLE reply ADD COLUMN text_editors uuid[] NOT NULL DEFAULT '{}';
UPDATE reply r SET text_editors = COALESCE((SELECT array_agg(DISTINCT x.created_by) FROM reply x WHERE x.case_id = r.case_id AND x.created_by IS NOT NULL), '{}');

-- C-FRD-8: closed_at decides; a Case closed before this change whose status moved on afterwards says closed again.
UPDATE "case" SET status = 'closed' WHERE closed_at IS NOT NULL AND status <> 'closed';

-- C-DRF-9: an approval given before this change was checked under the old rules: every approved, unsent reply goes back
-- to draft and needs approving again; its Case is open again. The audit entries need the key, so the app writes them at
-- start-up from this list (src/pipeline/rollout.ts) and empties it. The Case is kept with the reply (no foreign keys):
-- maintenance may delete the reply before start-up, and the entry is still written (code review round 2 D3).
CREATE TABLE rollout_lapsed_reply (reply_id uuid PRIMARY KEY, case_id uuid NOT NULL);
REVOKE ALL ON rollout_lapsed_reply FROM PUBLIC;
GRANT SELECT, DELETE ON rollout_lapsed_reply TO doi_app;
INSERT INTO rollout_lapsed_reply (reply_id, case_id) SELECT id, case_id FROM reply WHERE status = 'approved';
UPDATE reply SET status = 'draft', approved_by = NULL, approved_at = NULL, approved_generation = NULL, approved_manual_revision = NULL WHERE status = 'approved';
UPDATE "case" SET status = 'open' WHERE status = 'approved' AND closed_at IS NULL;

-- C-DRF-10: a case-level exception for a suspicious sender, approver or admin only, with a reason.
ALTER TABLE "case" ADD COLUMN recipient_override_by uuid REFERENCES app_user ON DELETE RESTRICT,
  ADD COLUMN recipient_override_at timestamptz,
  ADD COLUMN recipient_override_reason_blob uuid REFERENCES secret_blob ON DELETE RESTRICT;

-- C-FRD-5 (plan R1, owner 2026-11-10): the hash of the field values a verification task was made on; a later change of
-- that content invalidates it. NULL on tasks from before this change counts as changed: the start-up step invalidates
-- those tasks and runs their open Cases again, which makes new ones (code review round 2 D1).
ALTER TABLE verification_task ADD COLUMN bound_fields_sha256 text;
