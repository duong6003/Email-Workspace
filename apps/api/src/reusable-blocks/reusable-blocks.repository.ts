import { In, type EntityManager } from 'typeorm';
import { AppUserEntity } from '../database/entities/app-user.entity.js';
import { ReusableBlockEntity } from '../database/entities/reusable-block.entity.js';
import { TenantScopedRepository } from '../database/tenant-scoped.repository.js';

export class ReusableBlocksRepository extends TenantScopedRepository<ReusableBlockEntity> {
  constructor(manager: EntityManager, tenantId: string) {
    super(manager.getRepository(ReusableBlockEntity), tenantId);
    this.manager = manager;
  }

  private readonly manager: EntityManager;

  findById(id: string): Promise<ReusableBlockEntity | null> {
    return this.repository.findOne({ where: { id, tenantId: this.tenantId } });
  }

  /**
   * One list for the whole tenant -- there is no "my blocks" partition, because
   * ownership is the tenant (plan §S5 Task 26). Ordered by name so the panel is
   * stable between renames; Vietnamese collation is applied client-side with
   * `localeCompare(..., 'vi')` (spec §2.6), which Postgres's default collation
   * does not match.
   */
  list(): Promise<ReusableBlockEntity[]> {
    return this.repository.createQueryBuilder('block')
      .where('block.tenant_id = :tenantId', { tenantId: this.tenantId })
      .orderBy('lower(btrim(block.name))', 'ASC')
      .getMany();
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.repository.delete({ id, tenantId: this.tenantId });
    return (result.affected ?? 0) > 0;
  }

  /**
   * Display names for the `created_by` column the list shows. Attribution only
   * -- nothing here decides what anyone may do. Scoped by tenant as well as id
   * so a stale id from another tenant can never resolve to a name.
   */
  async creatorNames(ids: ReadonlyArray<string>): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.manager.getRepository(AppUserEntity).find({
      where: { id: In(unique), tenantId: this.tenantId },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
