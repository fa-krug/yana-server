export class AggregatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregatorError";
  }
}

export class ArticleSkipError extends AggregatorError {
  public statusCode: number;
  public originalError?: Error | null;

  constructor(message: string, statusCode = 400, originalError?: Error | null) {
    super(message);
    this.name = "ArticleSkipError";
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}
