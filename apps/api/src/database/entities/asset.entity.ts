import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { AllowedImageType } from '../../assets/asset-validation.js';
import type { AssetKind } from '../../assets/dto/asset.dto.js';

/**
 * MC-UI-005 asset (migration 076), per ADR-043.
 *
 * The object key is not a column: it is derived as `tenant/<tenantId>/<id>` by
 * `assetObjectKey` (ADR-043 §3), so the row and the store cannot drift apart.
 *
 * `contentType` reuses `AllowedImageType` from the validator rather than
 * redeclaring the union, so the four types the upload accepts, the four the
 * column's CHECK allows, and the four this entity admits stay one list.
 */
@Entity({ name: 'asset' })
@Index(['tenantId', 'createdAt'])
export class AssetEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'original_filename', type: 'text' }) originalFilename!: string;
  @Column({ name: 'content_type', type: 'text' }) contentType!: AllowedImageType;
  /**
   * ADR-044 Task SV-4 (migration 078): what a person says this file is, which
   * is a different question from `contentType`. The same PNG is a logo in one
   * tenant's brand kit and a photograph in another's newsletter, and magic
   * bytes cannot tell those apart -- so this one is chosen, not sniffed.
   */
  @Column({ type: 'text', default: 'image' }) kind!: AssetKind;
  @Column({ name: 'byte_size', type: 'int' }) byteSize!: number;
  /** Null when the dimensions were not read. The builder can lay an image out without them; nothing depends on their presence. */
  @Column({ type: 'int', nullable: true }) width!: number | null;
  @Column({ type: 'int', nullable: true }) height!: number | null;
  /** Who uploaded it. Attribution only, and unconstrained like 072's `published_by` and 075's `created_by`. */
  @Column({ name: 'created_by', type: 'uuid', nullable: true }) createdBy!: string | null;
  /**
   * ADR-043 §5: archiving hides an asset from the library but the public route
   * keeps serving it, because a published version still points at its URL and
   * cannot be edited. "Delete" in the UI sets this; nothing ever removes the row
   * or the object.
   */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true }) archivedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}
