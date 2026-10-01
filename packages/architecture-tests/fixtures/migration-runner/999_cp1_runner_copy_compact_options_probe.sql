CREATE TABLE cp1_runner_copy_compact_options_probe (
  id integer PRIMARY KEY
);

COPY cp1_runner_copy_compact_options_probe (id) FROM STDIN(FORMAT csv);
1
\.
