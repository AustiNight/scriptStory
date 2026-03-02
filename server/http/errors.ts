export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const toHttpError = (error: unknown): HttpError => {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof Error) {
    return new HttpError(500, "INTERNAL_ERROR", error.message);
  }

  return new HttpError(500, "INTERNAL_ERROR", "Unexpected server error.");
};
