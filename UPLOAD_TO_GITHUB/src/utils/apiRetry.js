/**
 * Helper to retry a function with exponential backoff
 * @param {Function} fn - The async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.initialDelay - Initial delay in ms (default: 1000)
 * @param {Function} options.onRetry - Callback function called on each retry
 * @returns {Promise<any>}
 */
export const withRetry = async (fn, { maxRetries = 3, initialDelay = 1000, onRetry = null } = {}) => {
    let lastError;
    let delay = initialDelay;

    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Only retry on 429 (Too Many Requests) or 5xx (Server Errors)
            const status = error.response?.status;
            const shouldRetry = status === 429 || (status >= 500 && status < 600) || error.code === 'ECONNABORTED';

            if (!shouldRetry || i === maxRetries) {
                throw error;
            }

            // Add jitter to delay (±20%)
            const jitter = delay * 0.2 * (Math.random() * 2 - 1);
            const finalDelay = Math.max(0, delay + jitter);

            console.warn(`API call failed (status: ${status}). Retrying ${i + 1}/${maxRetries} after ${Math.round(finalDelay)}ms...`);

            if (onRetry) {
                onRetry(i + 1, finalDelay, error);
            }

            await new Promise(resolve => setTimeout(resolve, finalDelay));
            delay *= 2; // Exponential backoff
        }
    }

    throw lastError;
};
