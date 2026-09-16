interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): unknown;
}

export function sendError<T extends string>(res: ErrorResponse, error: T | unknown, status = 400) {
  return res.status(status).json({ error } as { error: T });
}
