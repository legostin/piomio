// Errors that reach people as well as the model: the catalog message "error.<code>" is shown in the reader's language.
// Tool results take the English one, HTTP responses the language of whoever asked.

export type ErrorParams = Record<string, string | number>;

/** Codes that mean something was not there: HTTP 404. The rest are 400. */
const NOT_FOUND = new Set(["projectNotFound", "cardNotFound", "columnNotFound", "attachmentNotFound", "agentNotFound"]);

export class KanbanError extends Error {
  code: string;
  params: ErrorParams;
  constructor(code: string, params: ErrorParams = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
  get status(): number {
    return NOT_FOUND.has(this.code) ? 404 : 400;
  }
}
