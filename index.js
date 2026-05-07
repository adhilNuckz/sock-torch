/**
 * SOCKS5 proxy server implementation (RFC 1928 + RFC 1929) with a byte-safe
 * state machine using only Node.js built-in modules.
 */

const net = require("net");
const config = require("./config");
const { validateCredentials } = require("./auth");
const logger = require("./logger");

const SOCKS_VERSION = 0x05;
const AUTH_VERSION = 0x01;

const METHOD_USERNAME_PASSWORD = 0x02;
const METHOD_NO_ACCEPTABLE = 0xff;

const AUTH_STATUS_SUCCESS = 0x00;
const AUTH_STATUS_FAILURE = 0x01;

const CMD_CONNECT = 0x01;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONNECTION_NOT_ALLOWED = 0x02;
const REP_NETWORK_UNREACHABLE = 0x03;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONNECTION_REFUSED = 0x05;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;

const STATE_GREETING = "GREETING";
const STATE_AUTH = "AUTH";
const STATE_REQUEST = "REQUEST";
const STATE_CONNECTING = "CONNECTING";
const STATE_TUNNEL = "TUNNEL";
const STATE_CLOSED = "CLOSED";

function getSourceIp(socket) {
  if (!socket.remoteAddress) {
    return "-";
  }
  // Node can expose IPv4 mapped IPv6 (::ffff:127.0.0.1); normalize for logs.
  return socket.remoteAddress.replace(/^::ffff:/, "");
}

function parseGreeting(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const version = buffer[0];
  const methodsCount = buffer[1];
  const totalLength = 2 + methodsCount;
  if (buffer.length < totalLength) {
    return null;
  }
  return {
    version,
    methods: buffer.subarray(2, totalLength),
    bytesConsumed: totalLength,
  };
}

function parseAuthRequest(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const version = buffer[0];
  const usernameLength = buffer[1];
  if (buffer.length < 2 + usernameLength + 1) {
    return null;
  }
  const usernameStart = 2;
  const usernameEnd = usernameStart + usernameLength;
  const passwordLength = buffer[usernameEnd];
  const totalLength = usernameEnd + 1 + passwordLength;
  if (buffer.length < totalLength) {
    return null;
  }
  return {
    version,
    username: buffer.toString("utf8", usernameStart, usernameEnd),
    password: buffer.toString("utf8", usernameEnd + 1, totalLength),
    bytesConsumed: totalLength,
  };
}

function parseRequest(buffer) {
  if (buffer.length < 4) {
    return null;
  }

  const version = buffer[0];
  const command = buffer[1];
  const reserved = buffer[2];
  const atyp = buffer[3];
  let cursor = 4;
  let host = "";

  if (atyp === ATYP_IPV4) {
    if (buffer.length < cursor + 4 + 2) {
      return null;
    }
    host = `${buffer[cursor]}.${buffer[cursor + 1]}.${buffer[cursor + 2]}.${buffer[cursor + 3]}`;
    cursor += 4;
  } else if (atyp === ATYP_DOMAIN) {
    if (buffer.length < cursor + 1) {
      return null;
    }
    const domainLength = buffer[cursor];
    cursor += 1;
    if (buffer.length < cursor + domainLength + 2) {
      return null;
    }
    host = buffer.toString("utf8", cursor, cursor + domainLength);
    cursor += domainLength;
  } else if (atyp === ATYP_IPV6) {
    // Need the address+port bytes present so we can consume the full request frame.
    if (buffer.length < cursor + 16 + 2) {
      return null;
    }
    cursor += 16;
    const port = buffer.readUInt16BE(cursor);
    cursor += 2;
    return {
      version,
      command,
      reserved,
      atyp,
      host: "",
      port,
      bytesConsumed: cursor,
    };
  } else {
    return {
      version,
      command,
      reserved,
      atyp,
      host: "",
      port: 0,
      bytesConsumed: buffer.length,
    };
  }

  const port = buffer.readUInt16BE(cursor);
  cursor += 2;

  return {
    version,
    command,
    reserved,
    atyp,
    host,
    port,
    bytesConsumed: cursor,
  };
}

function buildMethodSelection(method) {
  return Buffer.from([SOCKS_VERSION, method]);
}

function buildAuthReply(status) {
  return Buffer.from([AUTH_VERSION, status]);
}

function buildSocksReply(rep) {
  // BND.ADDR/BND.PORT are set to 0.0.0.0:0 for simplicity.
  return Buffer.from([SOCKS_VERSION, rep, 0x00, ATYP_IPV4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function mapConnectErrorToReply(err) {
  if (!err || !err.code) {
    return REP_GENERAL_FAILURE;
  }
  if (err.code === "ECONNREFUSED") {
    return REP_CONNECTION_REFUSED;
  }
  if (err.code === "ENETUNREACH") {
    return REP_NETWORK_UNREACHABLE;
  }
  if (err.code === "EHOSTUNREACH" || err.code === "EAI_AGAIN" || err.code === "ENOTFOUND") {
    return REP_HOST_UNREACHABLE;
  }
  if (err.code === "EACCES" || err.code === "EPERM") {
    return REP_CONNECTION_NOT_ALLOWED;
  }
  return REP_GENERAL_FAILURE;
}

function createConnectionHandler() {
  return function onClientConnection(clientSocket) {
    const sourceIp = getSourceIp(clientSocket);
    let buffer = Buffer.alloc(0);
    let state = STATE_GREETING;
    let destinationSocket = null;
    let destinationLabel = "-";

    function closeClient() {
      if (state === STATE_CLOSED) {
        return;
      }
      state = STATE_CLOSED;
      clientSocket.destroy();
      if (destinationSocket) {
        destinationSocket.destroy();
      }
    }

    function consume(count) {
      buffer = buffer.subarray(count);
    }

    function processBuffer() {
      while (true) {
        if (state === STATE_CONNECTING || state === STATE_TUNNEL || state === STATE_CLOSED) {
          return;
        }

        if (state === STATE_GREETING) {
          const greeting = parseGreeting(buffer);
          if (!greeting) {
            return;
          }
          consume(greeting.bytesConsumed);

          if (greeting.version !== SOCKS_VERSION) {
            clientSocket.write(buildMethodSelection(METHOD_NO_ACCEPTABLE));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          const supportsUserPass = greeting.methods.includes(METHOD_USERNAME_PASSWORD);
          if (!supportsUserPass) {
            clientSocket.write(buildMethodSelection(METHOD_NO_ACCEPTABLE));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          clientSocket.write(buildMethodSelection(METHOD_USERNAME_PASSWORD));
          state = STATE_AUTH;
          continue;
        }

        if (state === STATE_AUTH) {
          const auth = parseAuthRequest(buffer);
          if (!auth) {
            return;
          }
          consume(auth.bytesConsumed);

          const validVersion = auth.version === AUTH_VERSION;
          const validCredentials =
            validVersion && validateCredentials(auth.username, auth.password, config);

          if (!validCredentials) {
            clientSocket.write(buildAuthReply(AUTH_STATUS_FAILURE));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          clientSocket.write(buildAuthReply(AUTH_STATUS_SUCCESS));
          state = STATE_REQUEST;
          continue;
        }

        if (state === STATE_REQUEST) {
          const request = parseRequest(buffer);
          if (!request) {
            return;
          }
          consume(request.bytesConsumed);

          if (request.version !== SOCKS_VERSION || request.reserved !== 0x00) {
            clientSocket.write(buildSocksReply(REP_GENERAL_FAILURE));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          if (request.command !== CMD_CONNECT) {
            clientSocket.write(buildSocksReply(REP_COMMAND_NOT_SUPPORTED));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          if (request.atyp === ATYP_IPV6) {
            clientSocket.write(buildSocksReply(REP_ADDRESS_TYPE_NOT_SUPPORTED));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          if (request.atyp !== ATYP_IPV4 && request.atyp !== ATYP_DOMAIN) {
            clientSocket.write(buildSocksReply(REP_ADDRESS_TYPE_NOT_SUPPORTED));
            logger.logConnection("ERROR", sourceIp, destinationLabel);
            closeClient();
            return;
          }

          destinationLabel = `${request.host}:${request.port}`;
          logger.logConnection("CONNECTING", sourceIp, destinationLabel);
          state = STATE_CONNECTING;

          destinationSocket = net.createConnection(
            { host: request.host, port: request.port },
            () => {
              if (state === STATE_CLOSED) {
                return;
              }

              clientSocket.write(buildSocksReply(REP_SUCCESS));
              logger.logConnection("CONNECTED", sourceIp, destinationLabel);

              // Client may have sent payload bytes while destination was still connecting.
              if (buffer.length > 0) {
                destinationSocket.write(buffer);
                buffer = Buffer.alloc(0);
              }

              state = STATE_TUNNEL;
              clientSocket.pipe(destinationSocket);
              destinationSocket.pipe(clientSocket);
            }
          );

          destinationSocket.on("error", (error) => {
            if (state === STATE_CLOSED) {
              return;
            }
            const rep = mapConnectErrorToReply(error);
            clientSocket.write(buildSocksReply(rep));
            logger.logError(sourceIp, destinationLabel, error);
            closeClient();
          });

          destinationSocket.on("close", () => {
            if (state === STATE_CLOSED) {
              return;
            }
            closeClient();
          });

          return;
        }
      }
    }

    clientSocket.on("data", (chunk) => {
      if (state === STATE_CLOSED) {
        return;
      }
      if (state === STATE_TUNNEL) {
        // Once piped, node stream plumbing handles forwarding bytes directly.
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });

    clientSocket.on("error", (error) => {
      if (state === STATE_CLOSED) {
        return;
      }
      logger.logError(sourceIp, destinationLabel, error);
      closeClient();
    });

    clientSocket.on("close", () => {
      if (destinationSocket) {
        destinationSocket.destroy();
      }
      state = STATE_CLOSED;
    });
  };
}

const server = net.createServer(createConnectionHandler());

server.on("error", (error) => {
  logger.logError("-", "-", error);
});

server.listen(config.PROXY_PORT, config.PROXY_HOST, () => {
  logger.logConnection("CONNECTED", config.PROXY_HOST, `proxy-listen:${config.PROXY_PORT}`);
});
