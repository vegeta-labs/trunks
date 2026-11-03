-- D9 (PRD R-DIR-04 / C-DRF-6 v0.7.24, tech design v0.7.14): a directory version made by an explicit clear
-- (`clear=yes`) is marked, so that only such a version counts as «no ledger». Versions imported before D9 stay
-- unmarked, including header-only ledgers that were accepted then (Codex D9 round 2 F2).
ALTER TABLE directory_version ADD COLUMN cleared boolean NOT NULL DEFAULT false;
