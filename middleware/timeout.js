/**
 * Request Timeout Middleware
 * Prevents hanging requests from consuming server resources
 */

/**
 * Request timeout middleware
 * Sets a timeout for requests and sends 408 if exceeded
 * @param {number} timeoutMs - Timeout in milliseconds (default: 30 seconds)
 */
export const requestTimeout = (timeoutMs = 30000) => {
  return (req, res, next) => {
    // Set timeout
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({
          error: 'Request timeout',
          message: 'The request took too long to process. Please try again.',
        });
        res.end();
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    const originalEnd = res.end;
    res.end = function (...args) {
      clearTimeout(timeout);
      originalEnd.apply(this, args);
    };

    // Clear timeout on error
    res.on('close', () => {
      clearTimeout(timeout);
    });

    next();
  };
};

