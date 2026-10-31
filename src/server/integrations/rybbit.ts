import { env } from "cloudflare:workers";
import { z } from "zod";
import { usesBetterAuth } from "@/lib/auth-mode";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { isAuditRenderingAllowed } from "@/server/lib/audit/rendering-policy";
import { AppError, asAppError } from "@/server/lib/errors";
import { responseForAppError } from "@/server/lib/http-errors";
import { startAuditSchema } from "@/types/schemas/audit";
import { resolveKediContext } from "./kedi-context";
import { ProjectService } from "@/server/features/projects/services/ProjectService";

const prefix = "/api/integrations/v1/";
const idSchema = z.string().uuid();

// A cookie-authenticated, server-to-server facade. The Rybbit BFF forwards a
// person's OpenSEO session, never an installation-wide administrator key.
export async function handleRybbitRequest(request: Request): Promise<Response> {
  let response: Response;
  try {
    if (!usesBetterAuth(env.AUTH_MODE)) throw new AppError("FORBIDDEN");
    if (request.headers.get("X-OpenSEO-Client") !== "rybbit")
      throw new AppError("FORBIDDEN");
    const requestUrl = new URL(request.url);
    // No CORS: browser requests go through a same-origin BFF. For writes,
    // require its explicit Origin as well as a non-simple request header.
    if (
      request.method === "POST" &&
      (request.headers.get("Origin") !== requestUrl.origin ||
        request.headers.get("Content-Type")?.split(";")[0] !==
          "application/json")
    )
      throw new AppError("FORBIDDEN");
    if (!["GET", "POST"].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, POST", "Cache-Control": "no-store" },
      });

    const kediContext = await resolveKediContext(request);
    const context = kediContext ?? await resolveUserContextFromHeaders(request.headers);
    const path = requestUrl.pathname.slice(prefix.length).split("/");
    if (
      request.method === "GET" &&
      path.length === 1 &&
      path[0] === "session"
    ) {
      response = Response.json({
        data: {
          userId: context.userId,
          email: context.userEmail,
          organizationId: context.organizationId,
        },
      });
    } else if (
      request.method === "GET" &&
      path.length === 1 &&
      path[0] === "projects"
    ) {
      const projects = kediContext
        ? await ProjectService.listProjectsEnsuringOne(context.organizationId)
        : await ProjectRepository.listProjects(context.organizationId);
      response = Response.json({
        data: projects.map(({ id, name, domain }) => ({ id, name, domain })),
      });
    } else {
      if (
        path[0] !== "projects" ||
        path[2] !== "audits" ||
        ![3, 4, 5].includes(path.length)
      )
        throw new AppError("NOT_FOUND");
      const projectId = idSchema.parse(path[1]);
      const project = await ProjectRepository.getProjectForOrganization(
        projectId,
        context.organizationId,
      );
      if (!project) throw new AppError("NOT_FOUND");
      if (path.length === 3 && request.method === "GET") {
        response = Response.json({
          data: await AuditService.getHistory(projectId),
        });
      } else if (path.length === 3 && request.method === "POST") {
        const input = startAuditSchema
          .omit({ projectId: true })
          .strict()
          .parse(await request.json());
        const limitTier = await AuditService.resolveAuditLimitTier(context);
        const result = await AuditService.startAudit({
          ...input,
          projectId,
          actorUserId: context.userId,
          billingCustomer: context,
          limitTier,
          renderJavaScript:
            input.renderJavaScript && (await isAuditRenderingAllowed()),
        });
        response = Response.json({ data: result }, { status: 202 });
      } else if (request.method === "GET" && path.length === 4) {
        response = Response.json({
          data: await AuditService.getStatus(
            idSchema.parse(path[3]),
            projectId,
          ),
        });
      } else if (
        request.method === "GET" &&
        path.length === 5 &&
        path[4] === "results"
      ) {
        const result = await AuditService.getResults(
          idSchema.parse(path[3]),
          projectId,
        );
        // Keep crawler credentials, config and raw provider payloads internal.
        response = Response.json({
          data: {
            audit: {
              id: result.audit.id,
              status: result.audit.status,
              startUrl: result.audit.startUrl,
              pagesCrawled: result.audit.pagesCrawled,
            },
            pages: result.pages.map(({ id, url, statusCode, title }) => ({
              id,
              url,
              statusCode,
              title,
            })),
            issues: result.issues.map(
              ({ id, pageUrl, issueType, severity }) => ({
                id,
                pageUrl,
                issueType,
                severity,
              }),
            ),
          },
        });
      } else throw new AppError("NOT_FOUND");
    }
  } catch (error) {
    const validationError =
      error instanceof z.ZodError || error instanceof SyntaxError;
    const code = validationError
      ? "VALIDATION_ERROR"
      : (asAppError(error)?.code ?? "INTERNAL_ERROR");
    const status = validationError
      ? 400
      : ((
          {
            AUDIT_ALREADY_RUNNING: 409,
            AUDIT_CAPACITY_REACHED: 409,
            AUDIT_PAGE_LIMIT_EXCEEDED: 400,
            AUDIT_RENDERING_UNAVAILABLE: 422,
          } as Record<string, number>
        )[code] ?? responseForAppError(error, "INTERNAL_ERROR").status);
    response = Response.json({ error: code }, { status });
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
