export class IngestError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "IngestError";
    this.code = options.code || "INGEST";
  }
}

export class ValidationError extends IngestError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "VALIDATION" });
    this.name = "ValidationError";
  }
}

export class FetchError extends IngestError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "FETCH" });
    this.name = "FetchError";
    if (options.status != null) this.status = options.status;
  }
}

export class AiError extends IngestError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "AI" });
    this.name = "AiError";
    if (options.diagnostic) this.diagnostic = options.diagnostic;
    if (options.status != null) this.status = options.status;
  }
}
