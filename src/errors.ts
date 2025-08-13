import { Response } from 'express';

export function sendError<T extends string>(res: Response, error: T | unknown, status = 400) {
  return res.status(status).json({ error } as { error: T });
}
