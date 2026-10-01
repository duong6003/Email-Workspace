ALTER TABLE configured_variable
  ADD CONSTRAINT configured_variable_template_owner_fk
  FOREIGN KEY (tenant_id, template_id)
  REFERENCES email_template(tenant_id, id)
  ON DELETE CASCADE;
