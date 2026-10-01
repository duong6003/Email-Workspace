import type { DataSource } from 'typeorm';

/**
 * Published versions deliberately reject normal DELETE statements. Integration
 * fixtures use the database owner to briefly disable that trigger under a
 * transaction-scoped advisory lock, so parallel suites cannot leave it off.
 */
export async function deleteTemplateVersionFixtures(dataSource: DataSource, tenantIds: string[]): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('eow_template_version_test_cleanup'))");
    await manager.query('ALTER TABLE email_template_version DISABLE TRIGGER email_template_version_immutable_trigger');
    try {
      await manager.query('DELETE FROM email_template_version WHERE tenant_id = ANY($1)', [tenantIds]);
    } finally {
      await manager.query('ALTER TABLE email_template_version ENABLE TRIGGER email_template_version_immutable_trigger');
    }
  });
}
