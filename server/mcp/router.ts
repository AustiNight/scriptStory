import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { FeatureFlags } from "../../config/featureFlags.ts";
import { sendSuccess } from "../http/envelope.ts";
import { HttpError } from "../http/errors.ts";
import { McpGateway } from "./gateway.ts";
import { McpRegistryStore } from "./registryStore.ts";

export interface McpRouterRuntimeConfig {
  featureFlags: FeatureFlags;
}

type RouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

export const createMcpRouter = (runtimeConfig: McpRouterRuntimeConfig): Router => {
  const router = Router();
  const store = new McpRegistryStore();
  const gateway = new McpGateway({ registryStore: store });

  router.use((_req, _res, next) => {
    if (!runtimeConfig.featureFlags.ENABLE_MCP_CONTEXT) {
      next(
        new HttpError(
          403,
          "FEATURE_DISABLED",
          "MCP context features are disabled. Set ENABLE_MCP_CONTEXT=true to enable these routes.",
          {
            requiredFlag: "ENABLE_MCP_CONTEXT",
          },
        ),
      );
      return;
    }

    next();
  });

  router.get("/servers", async (_req, res, next) => {
    try {
      const servers = await store.listServers();
      const items = servers.map((server) => ({
        ...server,
        health: gateway.getServerHealth(server),
      }));
      sendSuccess(res, {
        schemaVersion: 1,
        servers: items,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/servers", async (req, res, next) => {
    try {
      const created = await store.createServer(req.body);
      sendSuccess(
        res,
        {
          server: {
            ...created,
            health: gateway.getServerHealth(created),
          },
        },
        201,
      );
    } catch (error) {
      next(error);
    }
  });

  router.patch("/servers/:id", async (req, res, next) => {
    try {
      const serverId = req.params.id?.trim();
      if (!serverId) {
        throw new HttpError(400, "INVALID_REQUEST", "Server id is required.");
      }

      const updated = await store.patchServer(serverId, req.body);
      sendSuccess(res, {
        server: {
          ...updated,
          health: gateway.getServerHealth(updated),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/servers/:id", async (req, res, next) => {
    try {
      const serverId = req.params.id?.trim();
      if (!serverId) {
        throw new HttpError(400, "INVALID_REQUEST", "Server id is required.");
      }

      const deleted = await store.deleteServer(serverId);
      if (!deleted) {
        throw new HttpError(404, "MCP_SERVER_NOT_FOUND", `MCP server "${serverId}" was not found.`);
      }

      sendSuccess(res, {
        deleted: true,
        id: serverId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/servers/:id/test", async (req, res, next) => {
    try {
      const serverId = req.params.id?.trim();
      if (!serverId) {
        throw new HttpError(400, "INVALID_REQUEST", "Server id is required.");
      }

      const server = await store.getServerById(serverId);
      if (!server) {
        throw new HttpError(404, "MCP_SERVER_NOT_FOUND", `MCP server "${serverId}" was not found.`);
      }

      const probePayload = req.body && typeof req.body === "object" ? req.body : {};
      const result = await gateway.testServer(serverId, probePayload);

      sendSuccess(res, {
        result,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
