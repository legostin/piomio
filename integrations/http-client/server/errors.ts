// Errors that reach people as well as the model: the catalog message "error.<code>" is shown in the reader's language.
// Tool results take the English one, the page's requests the language of whoever asked.

export type ErrorParams = Record<string, string | number>;

const NOT_FOUND = new Set(["requestNotFound", "environmentNotFound", "entryNotFound"]);

export class ClientError extends Error {
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
