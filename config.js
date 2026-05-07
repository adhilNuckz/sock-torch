/**
 * Reads proxy configuration from environment variables and applies defaults.
 */

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

module.exports = {
  PROXY_PORT: parsePort(process.env.PROXY_PORT, 1080),
  PROXY_HOST: process.env.PROXY_HOST || "0.0.0.0",
  PROXY_USER: process.env.PROXY_USER || "admin",
  PROXY_PASS: process.env.PROXY_PASS || "secret123",
};
