export class NonRetryableJobError extends Error {
  constructor(message, code = 'NON_RETRYABLE') {
    super(message);
    this.name = 'NonRetryableJobError';
    this.code = code;
    this.nonRetryable = true;
  }
}

export const isNonRetryableJobError = (error) =>
  Boolean(error?.nonRetryable || error?.name === 'NonRetryableJobError');
