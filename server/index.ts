import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { GeminiWriter } from "./ai/geminiWriter.ts";
import { loadLocalEnv } from "./config/loadLocalEnv.ts";
import { bootstrapLocalData } from "./localData/bootstrap.ts";
import { sendError, sendSuccess } from "./http/envelope.ts";
import { HttpError, toHttpError } from "./http/errors.ts";

loadLocalEnv();

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const runtimeConfig = {
  host: process.env.API_HOST?.trim() || "127.0.0.1",
  port: parsePort(process.env.API_PORT, 4010),
  jsonPayloadLimit: process.env.API_JSON_LIMIT?.trim() || "2mb",
  providers: {
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || "",
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
  },
};

const geminiWriter = runtimeConfig.providers.geminiApiKey
  ? new GeminiWriter(runtimeConfig.providers.geminiApiKey)
  : null;

const requireGeminiWriter = (): GeminiWriter => {
  if (!geminiWriter) {
    throw new HttpError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "Gemini provider key is not configured on the server.",
      { missingEnv: "GEMINI_API_KEY" },
    );
  }

  return geminiWriter;
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: runtimeConfig.jsonPayloadLimit }));
app.use((_, res, next) => {
  res.locals.requestId = randomUUID();
  next();
});

app.get("/api/health", (_, res) => {
  sendSuccess(res, {
    status: "ok",
    api: {
      host: runtimeConfig.host,
      port: runtimeConfig.port,
      bindMode: "loopback-default",
    },
    providers: {
      geminiConfigured: Boolean(runtimeConfig.providers.geminiApiKey),
      openaiConfigured: Boolean(runtimeConfig.providers.openaiApiKey),
      anthropicConfigured: Boolean(runtimeConfig.providers.anthropicApiKey),
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.post(
  "/api/ai/gemini/summarize",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
      if (!transcript) {
        throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
      }

      const summary = await requireGeminiWriter().summarizeTranscript(transcript);
      sendSuccess(res, { summary });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/ai/gemini/analyze",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript : "";
      const projectContext = typeof req.body?.projectContext === "string" ? req.body.projectContext : "";
      const contextSources = Array.isArray(req.body?.contextSources) ? req.body.contextSources : [];

      if (!transcript.trim()) {
        throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
      }

      const toolCalls = await requireGeminiWriter().analyzeMeetingTranscript(
        transcript,
        projectContext,
        contextSources,
      );
      sendSuccess(res, { toolCalls });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/ai/gemini/refine",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawTranscript =
        typeof req.body?.rawTranscript === "string" ? req.body.rawTranscript.trim() : "";
      const fieldName = typeof req.body?.fieldName === "string" ? req.body.fieldName.trim() : "";
      const currentItem =
        req.body?.currentItem && typeof req.body.currentItem === "object" ? req.body.currentItem : null;
      const projectContext = typeof req.body?.projectContext === "string" ? req.body.projectContext : "";

      if (!rawTranscript || !fieldName || !currentItem) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Fields \"rawTranscript\", \"fieldName\", and \"currentItem\" are required.",
        );
      }

      const refinedText = await requireGeminiWriter().refineFieldContent(
        rawTranscript,
        fieldName,
        currentItem,
        projectContext,
      );
      sendSuccess(res, { refinedText });
    } catch (error) {
      next(error);
    }
  },
);

app.use((req: Request, _: Response, next: NextFunction) => {
  next(
    new HttpError(404, "NOT_FOUND", "API route not found.", {
      method: req.method,
      path: req.originalUrl,
    }),
  );
});

app.use((error: unknown, req: Request, res: Response, _: NextFunction) => {
  const normalized = toHttpError(error);

  if (normalized.status >= 500) {
    console.error(
      `[api:error] requestId=${res.locals.requestId} method=${req.method} path=${req.originalUrl} code=${normalized.code} message=${normalized.message}`,
    );
  }

  sendError(res, normalized);
});

const start = async (): Promise<void> => {
  const localDataBootstrap = await bootstrapLocalData();
  app.listen(runtimeConfig.port, runtimeConfig.host, () => {
    console.log(
      `[api] listening on http://${runtimeConfig.host}:${runtimeConfig.port} | local-data=${localDataBootstrap.localDataDir}`,
    );
  });
};

start().catch((error) => {
  const normalized = toHttpError(error);
  console.error(`[api] failed to start: ${normalized.code} ${normalized.message}`);
  process.exitCode = 1;
});
