-- F1 (PRD C-DIR-1a v0.7.28, tech design v0.7.18): the accounts a deal collects into. Only a keyed hash and the last four
-- characters are kept. NULL = no list for this deal, including every deal imported before this version.
ALTER TABLE deal ADD COLUMN receiving_accounts jsonb;
