import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { resolveKediContext } from "./kedi-context";

const mocks = vi.hoisted(() => ({
  env: { KEDI_SEO_SSO_SECRET: "test-secret-at-least-32-characters-long", KEDI_SEO_ADMIN_ORIGIN: "https://admin.example.com",
    KEDI_SEO_FRONTEND_ORIGIN: "https://seo.example.com" },
  user: vi.fn(), org: vi.fn(), membership: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("@/middleware/ensure-user/delegated", () => ({ ensureUserRecord: mocks.user }));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({ AuthRepository: {
  upsertDelegatedOrganization: mocks.org, upsertKediMembership: mocks.membership,
} }));
beforeEach(() => {
  mocks.user.mockResolvedValue(undefined);
  mocks.org.mockResolvedValue(undefined);
  mocks.membership.mockResolvedValue(undefined);
});
async function request(overrides: Record<string, unknown> = {}, method = "GET") {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: "12", iss: mocks.env.KEDI_SEO_ADMIN_ORIGIN, aud: "kedi-seo",
    organizationId: "63e88734-ce1f-4afb-a3ce-b1dce2e5d15c", tenantId: 1,
    appCode: "kedipage", role: "owner", embedOrigin: mocks.env.KEDI_SEO_FRONTEND_ORIGIN,
    iat: now, exp: now + 60, ...overrides,
  }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(mocks.env.KEDI_SEO_SSO_SECRET));
  return new Request("https://openseo.example.com/api/integrations/v1/session", {
    method, headers: { "X-Kedi-SEO-Grant": token },
  });
}
describe("Kedi delegated SEO context", () => {
  it("uses a separate organization for each tenant and a shared organization for colleagues", async () => {
    const first = await resolveKediContext(await request());
    const colleague = await resolveKediContext(await request({ sub: "13" }));
    const other = await resolveKediContext(await request({ tenantId: 2 }));
    expect(colleague?.organizationId).toBe(first?.organizationId);
    expect(colleague?.userId).not.toBe(first?.userId);
    expect(other?.organizationId).not.toBe(first?.organizationId);
    expect(mocks.membership).toHaveBeenCalledWith({ userId: first?.userId, organizationId: first?.organizationId, role: "owner" });
  });
  it.each([{ exp: 1 }, { iss: "https://evil.example.com" }, { aud: "other" },
    { embedOrigin: "https://evil.example.com" }, { exp: Math.floor(Date.now() / 1000) + 3600 }])(
    "rejects invalid authority before provisioning: %j", async overrides => {
      await expect(resolveKediContext(await request(overrides))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(mocks.user).not.toHaveBeenCalled();
    },
  );
  it("denies audit creation for staff", async () => {
    await expect(resolveKediContext(await request({ role: "staff" }, "POST"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.user).not.toHaveBeenCalled();
  });
});
