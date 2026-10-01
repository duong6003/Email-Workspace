import './observability/instrumentation.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { validateEnv } from './config/env.js';
import { JSON_BODY_LIMIT_BYTES } from './common/http-body-limit.js';
import { getOrCreateTraceId } from './common/trace-id.js';
import { appLogger, nestLogger } from './observability/logger.js';
import { runWithRequestContext } from './observability/request-context.js';

async function bootstrap(): Promise<void> {
  // Validated here, synchronously, before `NestFactory.create` -- not only
  // inside `ConfigModule.forRoot({ validate })` below. That validate call
  // still runs (ConfigService stays available to the rest of the app), but
  // by the time it does, `TypeOrmModule.forRootAsync` (app.module.ts) has
  // already started its own connection attempt in parallel: its useFactory
  // reads `process.env.DATABASE_URL` directly, with no injected
  // `ConfigService`, so nothing in Nest's DI graph makes it wait on config
  // validation. With `DATABASE_URL` unset that attempt falls back to pg's
  // default host/port -- on a machine with any Postgres listening on the
  // default 5432 (common in local dev, unrelated to this repo's own instance
  // on 55432), that is a real multi-second handshake-and-auth-failure retry
  // loop, not an instant refused connection. `boot.test.ts` measured it
  // keeping the process alive 15-20s before things unwound on their own,
  // comfortably past that test's 30s budget under any real load. Failing here
  // means the module graph -- and so that connection attempt -- never starts.
  validateEnv(process.env);

  // rawBody: true (D-109) -- attaches a verify callback to the JSON body parser
  // below so webhooks.controller.ts can read the exact signed bytes (req.rawBody)
  // alongside the normal parsed req.body every other route already uses. A
  // second, route-scoped body parser was tried first and rejected: Express's
  // global json() parser drains the request stream for any application/json
  // request before a route-scoped parser added later in the bootstrap sequence
  // ever runs, so a second parser would silently see an empty buffer, not an
  // error.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: nestLogger });
  app.use((request: Request, _response: Response, next: NextFunction) => runWithRequestContext({
    traceId: getOrCreateTraceId(request),
    tenantId: null,
    module: 'http',
  }, next));
  app.setGlobalPrefix('api/v1');
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
  await app.listen(Number(process.env.API_PORT ?? 3000));
}

// Belt and suspenders: nothing here ever called `process.exit()` before, so
// the process only died once the event loop drained naturally -- usually
// fine, but exactly what let the delay above through unnoticed. Exiting
// explicitly on any bootstrap failure (not just a validation one -- e.g.
// `app.listen`'s port already in use) makes the exit immediate instead of
// depending on whatever else happens to be pending.
bootstrap().catch((error: unknown) => {
  appLogger.fatal({ err: error }, 'bootstrap failed');
  process.exit(1);
});
