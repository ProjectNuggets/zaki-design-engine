import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export const ZAKI_TENANT_METADATA_KEY = 'zakiTenantId';

const ZAKI_PROJECT_ROLE_ACCESS = new Set(['owner', 'editor', 'viewer']);

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;
type ProjectRecord = {
  id?: string;
  metadata?: Record<string, unknown> | null;
} | null | undefined;

type RunRecord = {
  projectId?: string | null;
} | null | undefined;

type StorageProjectRecord = {
  id?: string;
  metadata?: Record<string, unknown> | null;
} | null | undefined;

type ProjectRoleRecord = {
  role?: string | null;
} | null | undefined;

type ZakiRequest = Request & {
  zakiHosted?: boolean;
  zakiTenantId?: string;
};

const TENANT_ID_RE = /^[A-Za-z0-9._:@-]{1,160}$/;
const HOSTED_BLOCKED_PATHS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/api\/dialog\//, reason: 'native host dialogs are not available in hosted mode' },
  { pattern: /^\/api\/import\/folder(?:\/|$)/, reason: 'local folder import is not available in hosted mode' },
  { pattern: /^\/api\/plugins\/upload-folder(?:\/|$)/, reason: 'local plugin folder upload is not available in hosted mode' },
  { pattern: /^\/api\/projects\/[^/]+\/working-dir(?:\/|$)/, reason: 'local working directory changes are not available in hosted mode' },
  { pattern: /^\/api\/projects\/[^/]+\/open-in(?:\/|$)/, reason: 'host application launching is not available in hosted mode' },
  { pattern: /^\/api\/projects\/[^/]+\/plugins\/install-folder(?:\/|$)/, reason: 'local plugin folder install is not available in hosted mode' },
];

export function isZakiHostedMode(env: Env = process.env): boolean {
  return (
    env.ZAKI_DESIGN_RUNTIME_MODE === 'hosted' ||
    env.ZAKI_RUNTIME_MODE === 'hosted' ||
    env.DESIGN_ENGINE_INTERNAL_AUTH_REQUIRED === 'true' ||
    env.ZAKI_DESIGN_HOSTED === 'true'
  );
}

export function resolveZakiInternalToken(env: Env = process.env): string {
  return (
    env.DESIGN_ENGINE_INTERNAL_TOKEN ||
    env.ZAKI_DESIGN_INTERNAL_TOKEN ||
    env.ZAKI_INTERNAL_TOKEN ||
    ''
  ).trim();
}

export function resolveZakiTenantHeader(env: Env = process.env): string {
  return (env.ZAKI_TENANT_HEADER || env.DESIGN_ENGINE_TENANT_HEADER || 'X-Zaki-User-Id').trim();
}

export function extractBearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)\s*$/i.exec(value);
  return match?.[1]?.trim() || null;
}

export function requestHasZakiInternalToken(req: Request, token: string): boolean {
  if (!token) return false;
  const bearer = extractBearerToken(req.get('authorization'));
  if (bearer === token) return true;
  return (req.get('x-internal-token') || '').trim() === token;
}

export function normalizeZakiTenantId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tenantId = raw.trim();
  if (!TENANT_ID_RE.test(tenantId)) return null;
  return tenantId;
}

export function tenantIdFromRequest(req: Request, env: Env = process.env): string | null {
  const headerName = resolveZakiTenantHeader(env);
  return normalizeZakiTenantId(req.get(headerName));
}

export function isZakiHostedRequest(req: Request): boolean {
  return (req as ZakiRequest).zakiHosted === true;
}

export function getZakiTenantId(req: Request): string | null {
  return normalizeZakiTenantId((req as ZakiRequest).zakiTenantId);
}

export function stampZakiTenantMetadata(req: Request, metadata: unknown): Record<string, unknown> | null {
  if (!isZakiHostedRequest(req)) {
    return metadata && typeof metadata === 'object'
      ? { ...(metadata as Record<string, unknown>) }
      : (metadata as null);
  }
  const tenantId = getZakiTenantId(req);
  if (!tenantId) return metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : null;
  const next = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {};
  next[ZAKI_TENANT_METADATA_KEY] = tenantId;
  return next;
}

export function projectBelongsToZakiTenant(project: ProjectRecord, tenantId: string | null): boolean {
  if (!tenantId) return false;
  const owner = normalizeZakiTenantId(project?.metadata?.[ZAKI_TENANT_METADATA_KEY]);
  return owner === tenantId;
}

export function projectAccessibleToZakiTenant(
  project: ProjectRecord,
  tenantId: string | null,
  role?: ProjectRoleRecord,
): boolean {
  if (!tenantId) return false;
  if (projectBelongsToZakiTenant(project, tenantId)) return true;
  const normalizedRole = typeof role?.role === 'string' ? role.role.trim().toLowerCase() : '';
  return ZAKI_PROJECT_ROLE_ACCESS.has(normalizedRole);
}

export function filterProjectsForZakiTenant<T extends ProjectRecord>(req: Request, projects: T[]): T[] {
  if (!isZakiHostedRequest(req)) return projects;
  const tenantId = getZakiTenantId(req);
  return projects.filter((project) => projectBelongsToZakiTenant(project, tenantId));
}

export function templateBelongsToZakiTenant(
  template: { sourceProjectId?: string | null } | null | undefined,
  tenantId: string | null,
  getProject: (id: string) => ProjectRecord,
): boolean {
  if (!tenantId) return false;
  if (!template?.sourceProjectId) return false;
  return projectBelongsToZakiTenant(getProject(template.sourceProjectId), tenantId);
}

export function filterTemplatesForZakiTenant<T extends { sourceProjectId?: string | null }>(
  req: Request,
  templates: T[],
  getProject: (id: string) => ProjectRecord,
): T[] {
  if (!isZakiHostedRequest(req)) return templates;
  const tenantId = getZakiTenantId(req);
  return templates.filter((template) => templateBelongsToZakiTenant(template, tenantId, getProject));
}

function isOpenProbePath(pathname: string): boolean {
  return (
    pathname === '/healthz' ||
    pathname === '/livez' ||
    pathname === '/readyz' ||
    pathname === '/api/health' ||
    pathname === '/api/version' ||
    pathname === '/api/daemon/status'
  );
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function projectIdFromPath(pathname: string): string | null {
  const match = /^\/api\/projects\/([^/?#]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function collectRequestProjectIds(req: Request): string[] {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const query = req.query && typeof req.query === 'object' ? req.query as Record<string, unknown> : {};
  const ids = [
    projectIdFromPath(req.path),
    firstString(query.projectId),
    firstString(body.projectId),
    firstString(body.sourceProjectId),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
}

function hostedBlockedPathReason(pathname: string): string | null {
  const blocked = HOSTED_BLOCKED_PATHS.find((entry) => entry.pattern.test(pathname));
  return blocked?.reason || null;
}

async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await directorySizeBytes(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.promises.stat(fullPath);
      total += stat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

export async function calculateZakiTenantStorageUsage(opts: {
  tenantId: string | null;
  projects: StorageProjectRecord[];
  projectsRoot: string;
  projectDir: (projectsRoot: string, projectId: string) => string;
}) {
  const tenantId = normalizeZakiTenantId(opts.tenantId);
  if (!tenantId) {
    return {
      ok: false,
      totalBytes: 0,
      projectCount: 0,
      projects: [] as Array<{ id: string; bytes: number }>,
    };
  }

  const usageProjects: Array<{ id: string; bytes: number }> = [];
  for (const project of opts.projects) {
    if (!project?.id || !projectBelongsToZakiTenant(project, tenantId)) continue;
    const projectPath = opts.projectDir(opts.projectsRoot, project.id);
    const bytes = await directorySizeBytes(projectPath);
    usageProjects.push({ id: project.id, bytes });
  }

  return {
    ok: true,
    totalBytes: usageProjects.reduce((sum, item) => sum + item.bytes, 0),
    projectCount: usageProjects.length,
    projects: usageProjects,
  };
}

function stampRequestBody(req: Request, tenantId: string): void {
  if (!req.body || typeof req.body !== 'object') return;
  const body = req.body as Record<string, unknown>;
  const isProjectCreate = req.method === 'POST' && req.path === '/api/projects';
  const isProjectPatch = req.method === 'PATCH' && /^\/api\/projects\/[^/]+$/.test(req.path);
  if (!isProjectCreate && !isProjectPatch) return;
  const metadata = body.metadata && typeof body.metadata === 'object'
    ? { ...(body.metadata as Record<string, unknown>) }
    : {};
  metadata[ZAKI_TENANT_METADATA_KEY] = tenantId;
  body.metadata = metadata;
}

export function createZakiHostedAuthMiddleware(opts: { env?: Env } = {}) {
  const env = opts.env ?? process.env;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isZakiHostedMode(env)) return next();
    const zakiReq = req as ZakiRequest;
    zakiReq.zakiHosted = true;
    if (isOpenProbePath(req.path)) return next();

    const token = resolveZakiInternalToken(env);
    if (!token) {
      return res.status(503).json({
        error: {
          code: 'ZAKI_INTERNAL_TOKEN_REQUIRED',
          message: 'DESIGN_ENGINE_INTERNAL_TOKEN or ZAKI_INTERNAL_TOKEN must be set in hosted mode',
        },
      });
    }
    if (!requestHasZakiInternalToken(req, token)) {
      return res.status(401).json({
        error: { code: 'ZAKI_INTERNAL_TOKEN_INVALID', message: 'internal service token required' },
      });
    }

    const tenantId = tenantIdFromRequest(req, env);
    if (!tenantId) {
      return res.status(400).json({
        error: { code: 'ZAKI_TENANT_REQUIRED', message: `${resolveZakiTenantHeader(env)} header required` },
      });
    }
    zakiReq.zakiTenantId = tenantId;
    stampRequestBody(req, tenantId);
    return next();
  };
}

export function createZakiHostedProjectMiddleware(opts: {
  env?: Env;
  getProject: (id: string) => ProjectRecord;
  getProjectRole?: (projectId: string, userId: string) => ProjectRoleRecord;
  getRun?: (id: string) => RunRecord;
}) {
  const env = opts.env ?? process.env;
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isZakiHostedMode(env) || isOpenProbePath(req.path)) return next();
    const tenantId = getZakiTenantId(req);
    if (!tenantId) return next();

    const blockedReason = hostedBlockedPathReason(req.path);
    if (blockedReason) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: blockedReason },
      });
    }

    const runMatch = /^\/api\/runs\/([^/?#]+)/.exec(req.path);
    if (runMatch && opts.getRun) {
      const runId = runMatch[1] ? decodeURIComponent(runMatch[1]) : '';
      const run = opts.getRun(runId);
      if (
        run?.projectId &&
        !projectAccessibleToZakiTenant(
          opts.getProject(run.projectId),
          tenantId,
          opts.getProjectRole?.(run.projectId, tenantId),
        )
      ) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
      }
    }

    if (req.path === '/api/runs' && req.method === 'GET' && typeof req.query.projectId !== 'string') {
      return res.status(400).json({
        error: { code: 'PROJECT_ID_REQUIRED', message: 'projectId query parameter required in hosted mode' },
      });
    }

    for (const projectId of collectRequestProjectIds(req)) {
      const project = opts.getProject(projectId);
      if (
        project &&
        !projectAccessibleToZakiTenant(project, tenantId, opts.getProjectRole?.(projectId, tenantId))
      ) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
      }
    }
    return next();
  };
}

function checkWritableDirectory(pathname: string) {
  try {
    fs.mkdirSync(pathname, { recursive: true });
    fs.accessSync(pathname, fs.constants.W_OK);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function zakiDesignReadiness(opts: {
  env?: Env;
  dataDir: string;
  projectsDir: string;
  dbCheck?: () => void;
}) {
  const env = opts.env ?? process.env;
  const hosted = isZakiHostedMode(env);
  const checks = [
    {
      name: 'hosted_mode',
      ok: hosted,
      message: hosted ? 'hosted mode enabled' : 'hosted mode disabled',
    },
    {
      name: 'internal_token',
      ok: !hosted || resolveZakiInternalToken(env).length > 0,
      message: 'internal token configured',
    },
    {
      name: 'tenant_header',
      ok: !hosted || resolveZakiTenantHeader(env).length > 0,
      message: `tenant header ${resolveZakiTenantHeader(env)}`,
    },
    {
      name: 'data_dir_writable',
      ...checkWritableDirectory(opts.dataDir),
    },
    {
      name: 'projects_dir_writable',
      ...checkWritableDirectory(opts.projectsDir),
    },
  ];

  if (opts.dbCheck) {
    try {
      opts.dbCheck();
      checks.push({ name: 'sqlite', ok: true, message: 'database reachable' });
    } catch (error) {
      checks.push({
        name: 'sqlite',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    service: 'zaki-design-engine',
    hosted,
    checks,
  };
}
