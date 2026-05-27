import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createZakiHostedAuthMiddleware,
  createZakiHostedProjectMiddleware,
  filterProjectsForZakiTenant,
} from '../src/zaki-hosted.js';

type Project = {
  id: string;
  metadata?: Record<string, unknown> | null;
};

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const servers: TestServer[] = [];

function listen(app: express.Express): Promise<TestServer> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const testServer = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) closeReject(error);
            else closeResolve();
          });
        }),
      };
      servers.push(testServer);
      resolve(testServer);
    });
  });
}

function hostedHeaders(tenantId: string) {
  return {
    'Content-Type': 'application/json',
    'X-Internal-Token': 'secret-token',
    'X-Zaki-User-Id': tenantId,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('zaki hosted mode', () => {
  it('requires an internal token and tenant header outside probes', async () => {
    const app = express();
    app.use(express.json());
    app.use(createZakiHostedAuthMiddleware({
      env: {
        ZAKI_DESIGN_RUNTIME_MODE: 'hosted',
        DESIGN_ENGINE_INTERNAL_TOKEN: 'secret-token',
      },
    }));
    app.get('/readyz', (_req, res) => res.json({ ok: true }));
    app.get('/api/projects', (_req, res) => res.json({ projects: [] }));

    const server = await listen(app);
    expect((await fetch(`${server.baseUrl}/readyz`)).status).toBe(200);
    expect((await fetch(`${server.baseUrl}/api/projects`)).status).toBe(401);
    expect((await fetch(`${server.baseUrl}/api/projects`, {
      headers: { 'X-Internal-Token': 'secret-token' },
    })).status).toBe(400);
  });

  it('stamps created projects and filters project lists by ZAKI tenant', async () => {
    const projects = new Map<string, Project>();
    const app = express();
    app.use(express.json());
    app.use(createZakiHostedAuthMiddleware({
      env: {
        ZAKI_DESIGN_RUNTIME_MODE: 'hosted',
        DESIGN_ENGINE_INTERNAL_TOKEN: 'secret-token',
      },
    }));
    app.use(createZakiHostedProjectMiddleware({
      env: {
        ZAKI_DESIGN_RUNTIME_MODE: 'hosted',
        DESIGN_ENGINE_INTERNAL_TOKEN: 'secret-token',
      },
      getProject: (id) => projects.get(id),
    }));
    app.post('/api/projects', (req, res) => {
      const project = {
        id: req.body.id,
        metadata: req.body.metadata,
      };
      projects.set(project.id, project);
      res.json({ project });
    });
    app.get('/api/projects', (req, res) => {
      res.json({ projects: filterProjectsForZakiTenant(req, [...projects.values()]) });
    });
    app.get('/api/projects/:id', (req, res) => {
      res.json({ project: projects.get(req.params.id) });
    });

    const server = await listen(app);
    const create = await fetch(`${server.baseUrl}/api/projects`, {
      method: 'POST',
      headers: hostedHeaders('user-a'),
      body: JSON.stringify({ id: 'design-1', name: 'Design 1', metadata: { kind: 'web' } }),
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({
      project: { metadata: { kind: 'web', zakiTenantId: 'user-a' } },
    });

    const userAList = await fetch(`${server.baseUrl}/api/projects`, {
      headers: hostedHeaders('user-a'),
    });
    expect(await userAList.json()).toMatchObject({ projects: [{ id: 'design-1' }] });

    const userBList = await fetch(`${server.baseUrl}/api/projects`, {
      headers: hostedHeaders('user-b'),
    });
    expect(await userBList.json()).toEqual({ projects: [] });

    const userBGet = await fetch(`${server.baseUrl}/api/projects/design-1`, {
      headers: hostedHeaders('user-b'),
    });
    expect(userBGet.status).toBe(404);
  });

  it('blocks unscoped run lists and cross-tenant run access', async () => {
    const projects = new Map<string, Project>([
      ['design-1', { id: 'design-1', metadata: { zakiTenantId: 'user-a' } }],
    ]);
    const runs = new Map([
      ['run-1', { projectId: 'design-1' }],
    ]);
    const app = express();
    app.use(express.json());
    app.use(createZakiHostedAuthMiddleware({
      env: {
        ZAKI_DESIGN_RUNTIME_MODE: 'hosted',
        DESIGN_ENGINE_INTERNAL_TOKEN: 'secret-token',
      },
    }));
    app.use(createZakiHostedProjectMiddleware({
      env: {
        ZAKI_DESIGN_RUNTIME_MODE: 'hosted',
        DESIGN_ENGINE_INTERNAL_TOKEN: 'secret-token',
      },
      getProject: (id) => projects.get(id),
      getRun: (id) => runs.get(id),
    }));
    app.get('/api/runs', (_req, res) => res.json({ runs: [] }));
    app.get('/api/runs/:id', (req, res) => res.json({ run: runs.get(req.params.id) }));

    const server = await listen(app);
    expect((await fetch(`${server.baseUrl}/api/runs`, {
      headers: hostedHeaders('user-a'),
    })).status).toBe(400);
    expect((await fetch(`${server.baseUrl}/api/runs/run-1`, {
      headers: hostedHeaders('user-b'),
    })).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/api/runs/run-1`, {
      headers: hostedHeaders('user-a'),
    })).status).toBe(200);
  });
});
