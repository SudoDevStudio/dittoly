-- Every change to a row bumps its revision, so a Flow can say "write this only if nothing changed since I read it"
-- (a table step's "ifRevision"): two runs that read, decide and write no longer overwrite each other silently.
ALTER TABLE data_rows ADD COLUMN revision integer NOT NULL DEFAULT 1;
