// Errors that reach people as well as the model. The message is English (tool results, logs); `code` and `params`
// let HTTP responses and the UI show the catalog message "error.<code>" in the reader's language.

export type ErrorParams = Record<string, string | number>;

export class TriggerError extends Error {
  code: string;
  params: ErrorParams;
  constructor(code: string, message: string, params: ErrorParams = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

/** The fields a run or a trigger state keeps about an error (code / params are absent for foreign errors). */
export function errorFields(e: unknown): { message: string; code?: string; params?: ErrorParams } {
  if (e instanceof TriggerError) return { message: e.message, code: e.code, params: e.params };
  return { message: (e as { message?: string })?.message ?? String(e) };
}
