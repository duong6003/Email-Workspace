CREATE TABLE cp1_runner_e_escape_bypass_probe (id integer PRIMARY KEY);
SELECT E'foo\''; SELECT 'COMMIT' \gexec
