import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { handleRybbitRequest } from "./rybbit";

const mocks = vi.hoisted(() => ({
  env: { AUTH_MODE: "password" },
  resolve: vi.fn(),
  projects: vi.fn(),
  project: vi.fn(),
  history: vi.fn(),
  status: vi.fn(),
  results: vi.fn(),
  start: vi.fn(),
  tier: vi.fn(),
  rendering: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolve,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    listProjects: mocks.projects,
    getProjectForOrganization: mocks.project,
  },
}));
vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: {
    getHistory: mocks.history,
    getStatus: mocks.status,
    getResults: mocks.results,
    startAudit: mocks.start,
    resolveAuditLimitTier: mocks.tier,
  },
}));
vi.mock("@/server/lib/audit/rendering-policy", () => ({
  isAuditRenderingAllowed: mocks.rendering,
}));

const projectId = "63e88734-ce1f-4afb-a3ce-b1dce2e5d15c";
const auditId = "b7034b10-42ba-4af9-851c-c6b0ff3984e0";
const context = {
  userId: "person",
  userEmail: "person@example.com",
  organizationId: "org-a",
  role: "owner",
  emailVerified: true,
};
function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) {
  const requestHeaders = {
    "X-OpenSEO-Client": "rybbit",
    Origin: "https://seo.example.com",
    "Content-Type": "application/json",
    ...headers,
  };
  const url = `https://seo.example.com/api/integrations/v1/${path}`;
  if (method === "GET") return new Request(url, { headers: requestHeaders });
  return new Request(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.env.AUTH_MODE = "password";
  mocks.resolve.mockResolvedValue(context);
  mocks.projects.mockResolvedValue([
    {
      id: projectId,
      name: "Store",
      domain: "store.example",
      indexnowKey: "private",
    },
  ]);
  mocks.project.mockResolvedValue({ id: projectId });
  mocks.history.mockResolvedValue([]);
  mocks.tier.mockResolvedValue("self_hosted");
  mocks.rendering.mockResolvedValue(false);
  mocks.start.mockResolvedValue({ auditId });
  mocks.status.mockResolvedValue({ id: auditId, status: "running" });
  mocks.results.mockResolvedValue({
    audit: {
      id: auditId,
      status: "completed",
      startUrl: "https://store.example",
      pagesCrawled: 1,
      config: { crawlerCredentialId: "secret" },
    },
    pages: [],
    issues: [],
    lighthouse: [{ raw: "private" }],
  });
});

describe("Rybbit integration API", () => {
  it("requires an authenticated user even with the integration header", async () => {
    mocks.resolve.mockRejectedValue(new AppError("UNAUTHENTICATED"));
    const response = await handleRybbitRequest(request("projects"));
    expect(response.status).toBe(401);
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("refuses no-auth deployments", async () => {
    mocks.env.AUTH_MODE = "local_noauth";
    expect((await handleRybbitRequest(request("projects"))).status).toBe(403);
  });

  it("rejects browser requests from a different origin before starting work", async () => {
    const response = await handleRybbitRequest(
      request(
        `projects/${projectId}/audits`,
        "POST",
        {},
        { Origin: "https://attacker.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("returns only public project fields from the current organization", async () => {
    const response = await handleRybbitRequest(request("projects"));
    expect(await response.json()).toEqual({
      data: [{ id: projectId, name: "Store", domain: "store.example" }],
    });
    expect(mocks.projects).toHaveBeenCalledWith("org-a");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("denies another organization's project before querying audits", async () => {
    mocks.project.mockResolvedValue(null);
    expect(
      (await handleRybbitRequest(request(`projects/${projectId}/audits`)))
        .status,
    ).toBe(404);
    expect(mocks.project).toHaveBeenCalledWith(projectId, "org-a");
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("passes the authenticated billing context and existing capacity tier to audit creation", async () => {
    const response = await handleRybbitRequest(
      request(`projects/${projectId}/audits`, "POST", {
        startUrl: "https://store.example",
        maxPages: 50,
        lighthouseStrategy: "none",
        renderJavaScript: true,
      }),
    );
    expect(response.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith({
      actorUserId: "person",
      billingCustomer: context,
      projectId,
      startUrl: "https://store.example",
      maxPages: 50,
      lighthouseStrategy: "none",
      renderJavaScript: false,
      limitTier: "self_hosted",
    });
  });

  it("rejects a body attempting to override the authorized project", async () => {
    const response = await handleRybbitRequest(
      request(`projects/${projectId}/audits`, "POST", {
        projectId: "other",
        startUrl: "https://store.example",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("scopes audit access to the authorized project", async () => {
    mocks.status.mockRejectedValue(new AppError("NOT_FOUND"));
    expect(
      (
        await handleRybbitRequest(
          request(`projects/${projectId}/audits/${auditId}`),
        )
      ).status,
    ).toBe(404);
    expect(mocks.status).toHaveBeenCalledWith(auditId, projectId);
  });

  it("omits crawler credentials and provider payloads from audit results", async () => {
    const response = await handleRybbitRequest(
      request(`projects/${projectId}/audits/${auditId}/results`),
    );
    const data = await response.json();
    expect(data).toEqual({
      data: {
        audit: {
          id: auditId,
          status: "completed",
          startUrl: "https://store.example",
          pagesCrawled: 1,
        },
        pages: [],
        issues: [],
      },
    });
  });

  it("hides internal error details", async () => {
    mocks.projects.mockRejectedValue(new Error("DB password=secret"));
    const response = await handleRybbitRequest(request("projects"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "INTERNAL_ERROR" });
  });

  it("reports the existing audit capacity refusal as a conflict", async () => {
    mocks.start.mockRejectedValue(new AppError("AUDIT_CAPACITY_REACHED"));
    const response = await handleRybbitRequest(
      request(`projects/${projectId}/audits`, "POST", {
        startUrl: "https://store.example",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "AUDIT_CAPACITY_REACHED" });
  });
});
