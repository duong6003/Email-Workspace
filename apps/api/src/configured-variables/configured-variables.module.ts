import { Module } from '@nestjs/common';
import { ConfiguredVariablesController } from './configured-variables.controller.js';
import { ConfiguredVariablesService } from './configured-variables.service.js';

@Module({ controllers: [ConfiguredVariablesController], providers: [ConfiguredVariablesService], exports: [ConfiguredVariablesService] })
export class ConfiguredVariablesModule {}
