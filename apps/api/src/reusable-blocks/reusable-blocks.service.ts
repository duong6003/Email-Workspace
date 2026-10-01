import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { ReusableBlockEntity } from '../database/entities/reusable-block.entity.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { ReusableBlocksRepository } from './reusable-blocks.repository.js';
import { blockShape } from './block-shape.js';
import type { CreateReusableBlockDto, UpdateReusableBlockDto } from './dto/reusable-block.dto.js';

/** Listing shape. `node` is absent on purpose -- see `listBlocks`. */
export type ReusableBlockSummary = {
  id: string;
  name: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * ADR-044 Task SV-4: the two numbers MC-UI-004's row preview draws (one bar
   * per column) and labels. Derived from the tree this projection is already
   * holding, so they cost nothing; `node` itself still stays out of the
   * listing, because ADR-035's projection is about payload and two integers
   * are not a tree.
   */
  columns: number;
  elements: number;
};

export type ReusableBlockResponse = ReusableBlockSummary & { node: unknown };

function summary(block: ReusableBlockEntity, creatorName: string | null): ReusableBlockSummary {
  return {
    id: block.id,
    name: block.name,
    createdBy: block.createdBy,
    createdByName: creatorName,
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
    ...blockShape(block.node),
  };
}

@Injectable()
export class ReusableBlocksService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The listing omits `node`, following the projection ADR-035 established for
   * the template library: a block tree is the same order of payload as a
   * template's, and the panel only needs names to render. The tree is fetched
   * once, by `getBlock`, at the moment the user actually inserts one.
   */
  listBlocks(tenantId: string): Promise<ReusableBlockSummary[]> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new ReusableBlocksRepository(manager, tenantId);
      const blocks = await repository.list();
      const names = await repository.creatorNames(blocks.map((block) => block.createdBy).filter((id): id is string => id !== null));
      return blocks.map((block) => summary(block, block.createdBy ? names.get(block.createdBy) ?? null : null));
    });
  }

  getBlock(tenantId: string, id: string): Promise<ReusableBlockResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new ReusableBlocksRepository(manager, tenantId);
      const block = await repository.findById(id);
      if (!block) throw new NotFoundException('Reusable block not found.');
      return this.withNode(block, await this.creatorName(repository, block));
    });
  }

  create(tenantId: string, actorId: string | null, body: CreateReusableBlockDto): Promise<ReusableBlockResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new ReusableBlocksRepository(manager, tenantId);
      const saved = await this.guardNameConflict(() => repository.save({
        name: body.name.trim(),
        node: body.node,
        createdBy: actorId,
      }));
      return this.withNode(saved, await this.creatorName(repository, saved));
    });
  }

  /**
   * Rename. Deliberately not scoped to the creator: under tenant ownership
   * (plan §S5 Task 26) anyone with `content:manage` renames any block in the
   * tenant, and `createdBy` is left alone so attribution still records who
   * saved it rather than who last touched it.
   */
  update(tenantId: string, id: string, body: UpdateReusableBlockDto): Promise<ReusableBlockResponse> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new ReusableBlocksRepository(manager, tenantId);
      const block = await repository.findById(id);
      if (!block) throw new NotFoundException('Reusable block not found.');
      const saved = await this.guardNameConflict(() => repository.save({ ...block, name: body.name.trim() }));
      return this.withNode(saved, await this.creatorName(repository, saved));
    });
  }

  /**
   * Hard delete, and that is safe here in a way it is not for assets
   * (ADR-043 §5): inserting a block copies its subtree into the document, so
   * every template that used it owns its own copy and nothing dangles.
   */
  remove(tenantId: string, id: string): Promise<void> {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const removed = await new ReusableBlocksRepository(manager, tenantId).remove(id);
      if (!removed) throw new NotFoundException('Reusable block not found.');
    });
  }

  private withNode(block: ReusableBlockEntity, creatorName: string | null): ReusableBlockResponse {
    return { ...summary(block, creatorName), node: block.node };
  }

  private async creatorName(repository: ReusableBlocksRepository, block: ReusableBlockEntity): Promise<string | null> {
    if (!block.createdBy) return null;
    return (await repository.creatorNames([block.createdBy])).get(block.createdBy) ?? null;
  }

  /** Unique per tenant, not per creator (Task 26). Same normalized collision and same 409 shape the template library already returns (BR-TPL-010). */
  private async guardNameConflict<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'REUSABLE_BLOCK_NAME_CONFLICT', message: 'A reusable block with this name already exists.' });
      }
      throw error;
    }
  }
}
