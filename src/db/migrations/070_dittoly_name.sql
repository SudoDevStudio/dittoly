-- A new git connection's folder defaults to "dittoly". Connections made before keep the folder they have, so the
-- files already in their repositories stay where they are.
ALTER TABLE git_connections ALTER COLUMN folder SET DEFAULT 'dittoly';
