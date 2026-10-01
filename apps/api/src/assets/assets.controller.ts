import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res, UnauthorizedException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { AuditLog } from '../common/decorators/audit-log.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { AssetsService } from './assets.service.js';
import { MAX_ASSET_BYTES } from './asset-validation.js';
import { assetKindSchema, isAssetId, parseAssetKind, type AssetKind } from './dto/asset.dto.js';

function tenantId(request: AuthenticatedRequest): string {
  if (!request.auth) throw new UnauthorizedException('Not authenticated.');
  return request.auth.tenantId;
}

function requestParam(request: AuthenticatedRequest, key: string): string | null {
  const value = request.params[key];
  return typeof value === 'string' ? value : null;
}

/** Multer holds the body in memory: 5 MB is the cap anyway (ADR-043 §4), so a disk round-trip would buy nothing and add a file to clean up. */
const uploadOptions = { limits: { fileSize: MAX_ASSET_BYTES, files: 1 } };

function requireFile(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new BadRequestException('No file was uploaded.');
  return file;
}

/**
 * ADR-044 Task SV-4. `kind` arrives as a multipart TEXT field beside the file,
 * so it is read off the parsed body rather than through a DTO pipe -- there is
 * no JSON body on these two routes to validate.
 *
 * A present-but-wrong value is a 400 rather than a silent default: filing an
 * asset somewhere the caller did not ask for, and never telling them, is the
 * worse of the two failures. Absent or blank is not wrong -- see parseAssetKind.
 */
function requireKind(request: AuthenticatedRequest): AssetKind {
  const kind = parseAssetKind((request.body as Record<string, unknown> | undefined)?.kind);
  if (!kind) throw new BadRequestException('kind must be "logo" or "image".');
  return kind;
}

/**
 * MC-UI-005 (ADR-043).
 *
 * Every route here is authenticated and RBAC-checked EXCEPT the serving route,
 * which is `@Public()` because the fetch comes from a recipient's mail client
 * and carries none of our cookies. That is the deliberate consequence recorded
 * in ADR-043 §2: the asset id is a bearer capability, so the store is not a
 * place for sensitive files, and the UI says so at the upload point.
 *
 * The serving route takes an id and a display filename. The filename is not
 * consulted at all -- it exists so the URL ends in something human-readable and
 * so mail clients infer a sane name. Nothing here accepts a path or a storage
 * key, so there is no traversal surface: the key is derived from the id's own
 * row (`tenant/<tenant_id>/<id>`).
 */
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get() @RequirePermission(PERMISSIONS.CONTENT_READ, PERMISSIONS.CONTENT_MANAGE)
  async list(@Req() request: AuthenticatedRequest) {
    return { items: await this.assets.list(tenantId(request)) };
  }

  @Post() @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  @AuditLog({ action: 'asset.uploaded', entityType: 'asset', resolveEntityId: ({ result }) => (result as { id?: string } | undefined)?.id ?? null })
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Req() request: AuthenticatedRequest) {
    const uploaded = requireFile(file);
    return this.assets.upload(tenantId(request), request.auth?.userId ?? null, uploaded.originalname, uploaded.buffer, requireKind(request));
  }

  @Post(':id/replace') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  @AuditLog({ action: 'asset.replaced', entityType: 'asset', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  replace(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Req() request: AuthenticatedRequest) {
    const uploaded = requireFile(file);
    // No `requireKind` here: an absent field on a replace means "same as
    // before", which the service resolves from the existing row, not the
    // upload default. Only a value the caller actually sent is honoured.
    const stated = (request.body as Record<string, unknown> | undefined)?.kind;
    const kind = stated === undefined || stated === '' ? undefined : (parseAssetKind(stated) ?? undefined);
    if (stated !== undefined && stated !== '' && kind === undefined) throw new BadRequestException('kind must be "logo" or "image".');
    return this.assets.replace(tenantId(request), request.auth?.userId ?? null, id, uploaded.originalname, uploaded.buffer, kind);
  }

  /**
   * DELETE archives; it never removes anything (ADR-043 §5). The verb matches
   * `DELETE /templates/:id`, which has meant "archive" in this codebase since
   * 015 -- and the database backs it up by not granting eow_app DELETE at all.
   */
  /**
   * ADR-044 Task SV-4: the one mutable field on an asset. PATCH rather than a
   * replace because no bytes move and no id is minted -- ADR-043 §7's
   * archive-and-recreate rule is about content a published email points at,
   * and a label is not that.
   */
  @Patch(':id') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'asset.reclassified', entityType: 'asset', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  setKind(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    // The STRICT schema, not `parseAssetKind`. That one is lenient by design
    // for a multipart form -- absent or blank means "not stated", which is the
    // upload default. In a JSON body there is no blank control to be lenient
    // about: `{"kind": ""}` is a caller sending a wrong value, and answering it
    // with a silent "image" would file the asset somewhere nobody asked for.
    const parsed = assetKindSchema.safeParse((body as Record<string, unknown> | undefined)?.kind);
    if (!parsed.success) throw new BadRequestException('kind must be "logo" or "image".');
    return this.assets.setKind(tenantId(request), id, parsed.data);
  }

  @Delete(':id') @HttpCode(204) @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.CONTENT_MANAGE)
  @AuditLog({ action: 'asset.archived', entityType: 'asset', resolveEntityId: ({ request }) => requestParam(request, 'id') })
  archive(@Param('id', ParseUUIDPipe) id: string, @Req() request: AuthenticatedRequest) {
    return this.assets.archive(tenantId(request), id);
  }

  @Public()
  @Get(':id/:filename')
  async serve(@Param('id') id: string, @Res() response: Response): Promise<void> {
    // 404 rather than 400 for a malformed id, deliberately. This is a public
    // capability URL: "that is not a valid id" and "no such asset" are the same
    // answer to anyone allowed to ask, and one answer is one fewer signal for a
    // prober. The authenticated routes above use ParseUUIDPipe instead, because
    // there the caller is our own UI and a precise 400 is more useful.
    if (!isAssetId(id)) { response.status(404).end(); return; }
    const asset = await this.assets.serve(id);
    if (!asset) { response.status(404).end(); return; }
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('Content-Length', String(asset.byteSize));
    // The bytes at an id never change -- `replace` mints a new id rather than
    // overwriting (ADR-043 §7) -- so this can be cached as long as anything is.
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // The content type is the sniffed one, and this stops a client second-
    // guessing it. Together they are what make serving user bytes from our own
    // origin safe enough to do at all.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    asset.body.pipe(response);
  }
}
