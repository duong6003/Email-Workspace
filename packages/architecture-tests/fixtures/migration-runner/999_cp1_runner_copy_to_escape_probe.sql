CREATE TABLE cp1_runner_copy_to_escape_probe (
  id integer PRIMARY KEY
);

CREATE TABLE stdin (
  value text NOT NULL
);

INSERT INTO stdin (value) VALUES ('probe');
COPY (SELECT value FROM stdin AS source) TO STDOUT;
COMMIT;
\.
SELECT 1 / 0;
