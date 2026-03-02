import type { Response } from "express";
import type { HttpError } from "./errors.ts";

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
  timestamp: string;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}

export const getRequestId = (res: Response): string => {
  const requestId = res.locals.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown-request";
};

export const sendSuccess = <T>(res: Response, data: T, status = 200): Response<SuccessEnvelope<T>> => {
  const requestId = getRequestId(res);
  return res.status(status).json({
    ok: true,
    data,
    requestId,
    timestamp: new Date().toISOString(),
  });
};

export const sendError = (res: Response, error: HttpError): Response<ErrorEnvelope> => {
  const requestId = getRequestId(res);
  return res.status(error.status).json({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    requestId,
    timestamp: new Date().toISOString(),
  });
};
