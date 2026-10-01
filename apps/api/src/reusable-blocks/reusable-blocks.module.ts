import { Module } from '@nestjs/common';
import { ReusableBlocksController } from './reusable-blocks.controller.js';
import { ReusableBlocksService } from './reusable-blocks.service.js';

@Module({ controllers: [ReusableBlocksController], providers: [ReusableBlocksService], exports: [ReusableBlocksService] })
export class ReusableBlocksModule {}
