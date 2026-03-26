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
    // Routes that need longer timeouts (in milliseconds)
    const extendedTimeoutRoutes = {
      '/api/exams/generate-questions': 300000, // 5 minutes for AI question generation
      '/api/exams/import-questions': 300000,    // 5 minutes for AI question extraction from files
      '/api/omr/extract-id': 90000, // 90 seconds for OCR-based identity extraction
      '/api/super-admin/backups': 600000, // 10 minutes for large backup creation
      '/api/super-admin/backups/restore-upload': 600000, // 10 minutes for upload + restore
      '/api/admin/system/backup': 600000, // 10 minutes for large backup creation
      '/api/admin/system/restore': 600000, // 10 minutes for upload + restore
    };
    const extendedTimeoutPatterns = [
      {
        pattern: /^\/api\/exam-attempts\/[a-fA-F0-9]{24}\/submit$/,
        timeout: 120000, // 2 minutes for exam submission payload persistence
      },
      {
        pattern: /^\/api\/exams\/submit$/,
        timeout: 120000, // 2 minutes for unified exam submit endpoint
      },
      {
        pattern: /^\/api\/super-admin\/backups\/[a-fA-F0-9]{24}\/restore$/,
        timeout: 600000, // 10 minutes for restore operation
      },
      {
        pattern: /^\/api\/super-admin\/backups\/[a-fA-F0-9]{24}\/download$/,
        timeout: 600000, // 10 minutes for large backup downloads
      },
      {
        pattern: /^\/api\/admin\/system\/backups\/[a-fA-F0-9]{24}\/restore$/,
        timeout: 600000, // 10 minutes for restore operation
      },
      {
        pattern: /^\/api\/admin\/system\/backups\/[a-fA-F0-9]{24}\/download$/,
        timeout: 600000, // 10 minutes for large backup downloads
      },
    ];

    // Check if this route needs an extended timeout
    const routePath = req.path;
    const extendedTimeout =
      extendedTimeoutRoutes[routePath] ||
      extendedTimeoutPatterns.find((entry) => entry.pattern.test(routePath))?.timeout;
    const actualTimeout = extendedTimeout || timeoutMs;

    // Set timeout
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({
          error: 'Request timeout',
          message: 'The request took too long to process. Please try again.',
        });
        res.end();
      }
    }, actualTimeout);

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

