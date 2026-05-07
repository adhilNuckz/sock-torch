/**
 * Validates username/password pairs for SOCKS5 RFC 1929 authentication.
 */

function validateCredentials(username, password, config) {
  return username === config.PROXY_USER && password === config.PROXY_PASS;
}

module.exports = {
  validateCredentials,
};
