import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppUserEntity } from '../database/entities/app-user.entity.js';
import { LoginAttemptEntity } from '../database/entities/login-attempt.entity.js';
import { PasswordResetTokenEntity } from '../database/entities/password-reset-token.entity.js';
import { UserSessionEntity } from '../database/entities/user-session.entity.js';
import { AuditLogEntity } from '../database/entities/audit-log.entity.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { LoginAttemptService } from './login-attempt.service.js';
import { PermissionsService } from './permissions.service.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([AppUserEntity, UserSessionEntity, LoginAttemptEntity, PasswordResetTokenEntity, AuditLogEntity])],
  controllers: [AuthController],
  providers: [AuthService, SessionService, LoginAttemptService, PermissionsService, AuthGuard, CsrfGuard],
  exports: [AuthService, SessionService, PermissionsService, AuthGuard],
})
export class AuthModule {}
