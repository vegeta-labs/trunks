-- E5 (tech design v0.7.11, PRD R-DEMO-01 v0.7.22): the demo marker. Only the owner role writes it (in `migrate` with
-- DEMO=1 on an empty database); every other role can only read it, so it cannot be planted from the application.
CREATE TABLE demo_marker (
  id int PRIMARY KEY CHECK (id = 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON demo_marker FROM PUBLIC;
GRANT SELECT ON demo_marker TO doi_app, doi_maintenance, doi_rotation;
