import type { DeepPartial, FindOptionsWhere, Repository } from 'typeorm';

type TenantOwned = { tenantId: string };

/**
 * Wraps a TypeORM repository so every read is filtered by tenantId and every
 * write is stamped with it, regardless of what the caller passes in. This is
 * the enforcement point for BR-GEN-002 (tenant scope) — callers cannot opt out.
 */
export class TenantScopedRepository<T extends TenantOwned> {
  constructor(
    protected readonly repository: Repository<T>,
    protected readonly tenantId: string,
  ) {}

  find(where: FindOptionsWhere<T> = {} as FindOptionsWhere<T>): Promise<T[]> {
    return this.repository.find({ where: { ...where, tenantId: this.tenantId } as FindOptionsWhere<T> });
  }

  findOne(where: FindOptionsWhere<T>): Promise<T | null> {
    return this.repository.findOne({ where: { ...where, tenantId: this.tenantId } as FindOptionsWhere<T> });
  }

  save(entity: DeepPartial<T>): Promise<T> {
    return this.repository.save({ ...entity, tenantId: this.tenantId } as DeepPartial<T>);
  }

  /** Bulk insert (no upsert/lifecycle hooks, matching Repository.insert()); every row is stamped with tenantId regardless of what the caller passes in. */
  async insertMany(entities: ReadonlyArray<DeepPartial<T>>): Promise<void> {
    if (entities.length === 0) return;
    await this.repository.insert(entities.map((entity) => ({ ...entity, tenantId: this.tenantId })) as never);
  }
}
