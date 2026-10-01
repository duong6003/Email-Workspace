CREATE TABLE cp1_runner_copy_payload_crlf_probe (value text NOT NULL);
COPY cp1_runner_copy_payload_crlf_probe (value) FROM STDIN WITH (FORMAT csv);
COMMIT
\q
 \.
\.
