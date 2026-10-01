CREATE TABLE cp1_runner_copy_to_function_escape_probe (
  id integer PRIMARY KEY
);

CREATE FUNCTION stdin() RETURNS TABLE(value text)
LANGUAGE sql
AS $$ SELECT 'probe'::text $$;

COPY (SELECT value FROM stdin()) TO STDOUT;
COMMIT;
\.
SELECT 1 / 0;
