import { env } from "cloudflare:workers";
import { jwtVerify } from "jose";
import { z } from "zod";
import { ensureUserRecord } from "@/middleware/ensure-user/delegated";
import type { EnsuredUserContext } from "@/middleware/ensure-user/types";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { AppError } from "@/server/lib/errors";

const claimsSchema = z.object({
  iss: z.string().url(), sub: z.string().min(1).max(256),
  organizationId: z.string().uuid(), tenantId: z.number().int().positive(),
  appCode: z.string().min(1).max(50), role: z.enum(["owner", "admin", "staff"]),
  embedOrigin: z.string().url(), iat: z.number(), exp: z.number(),
});

export async function resolveKediContext(request: Request): Promise<EnsuredUserContext | null> {
  const token = request.headers.get("X-Kedi-SEO-Grant");
  if (!token) return null;
  const secret = Reflect.get(env, "KEDI_SEO_SSO_SECRET");
  const issuer = Reflect.get(env, "KEDI_SEO_ADMIN_ORIGIN");
  const frontend = Reflect.get(env, "KEDI_SEO_FRONTEND_ORIGIN");
  let claims;
  try {
    if (typeof secret !== "string" || secret.length < 32 || typeof issuer !== "string" || !issuer) throw new Error();
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"], issuer, audience: "kedi-seo", requiredClaims: ["exp", "iat", "sub"],
    });
    claims = claimsSchema.parse(payload);
    if (claims.embedOrigin !== frontend || claims.exp - claims.iat > 60 || claims.exp <= claims.iat ||
      claims.iat > Math.floor(Date.now() / 1000) + 5) throw new Error();
  } catch { throw new AppError("UNAUTHENTICATED"); }
  if (request.method !== "GET" && claims.role === "staff") throw new AppError("FORBIDDEN");
  const digest = async (value: string) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  };
  const org = await digest(JSON.stringify([claims.iss, claims.appCode, claims.organizationId, claims.tenantId]));
  const person = await digest(JSON.stringify([org, claims.sub]));
  const userId = `kedi-${person}`;
  const organizationId = `kedi-${org}`;
  const email = `${person}@sso.kedi.invalid`;
  const role = claims.role === "staff" ? "viewer" : claims.role;
  await ensureUserRecord(userId, email);
  await AuthRepository.upsertDelegatedOrganization({ id: organizationId,
    slug: organizationId, name: `Kedi workspace ${claims.tenantId}` });
  await AuthRepository.upsertKediMembership({ userId, organizationId, role });
  return { userId, userEmail: email, emailVerified: true, organizationId, role };
}
