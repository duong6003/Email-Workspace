CREATE TABLE cp1_runner_copy_csv_probe (
  id integer PRIMARY KEY
);

COPY cp1_runner_copy_csv_probe (id) FROM STDIN CSV;
1
\.
