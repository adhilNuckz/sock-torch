/**
 * Centralized logging helpers for connection lifecycle events.
 * Writes logs to both stdout and a log file.
 */

const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "socks5-proxy.log");

function timestamp() {
  return new Date().toISOString();
}

function normalizeValue(value) {
  return value || "-";
}

function writeLog(message) {
  // Write to stdout for real-time monitoring
  process.stdout.write(message + "\n");
  
  // Write to file for persistence
  fs.appendFileSync(LOG_FILE, message + "\n", { encoding: "utf8" });
}

function logConnection(status, src, dst) {
  const message = `[${timestamp()}] ${status} | src=${normalizeValue(src)} | dst=${normalizeValue(dst)}`;
  writeLog(message);
}

function logError(src, dst, error) {
  const errorMessage = error && error.message ? error.message : String(error);
  const message = `[${timestamp()}] ERROR | src=${normalizeValue(src)} | dst=${normalizeValue(dst)} | error=${errorMessage}`;
  writeLog(message);
}

module.exports = {
  logConnection,
  logError,
};
