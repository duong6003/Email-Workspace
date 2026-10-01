CREATE TABLE cp1_runner_concurrency_probe (
  id integer PRIMARY KEY
);

SELECT pg_sleep(1);

INSERT INTO cp1_runner_concurrency_probe (id) VALUES (1);
