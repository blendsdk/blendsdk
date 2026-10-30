/**
 * Waits for Mailpit's SMTP and HTTP ports before the package tests start.
 *
 * `docker-compose up -d` returns once the container is created and does not
 * consult its healthcheck. The old fixed `sleep 5` was too short on loaded CI
 * runners, so the first SMTP sends timed out. Poll both ports the tests use
 * and fail fast when Mailpit never becomes ready.
 */

import { connect } from "node:net";

const HOST = "localhost";
const SMTP_PORT = 1025;
const HTTP_PORT = 8025;
const TIMEOUT_MS = 30_000;
const RETRY_MS = 500;
const CONNECT_TIMEOUT_MS = 1_000;

/**
 * Checks whether a TCP port accepts connections.
 *
 * @param {number} port - Port to connect to.
 * @returns {Promise<boolean>} True when the connection succeeds.
 */
function canConnect(port) {
    return new Promise(resolve => {
        const socket = connect({ host: HOST, port });

        const finish = reachable => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(CONNECT_TIMEOUT_MS);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });
}

const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline) {
    const [smtpReady, httpReady] = await Promise.all([
        canConnect(SMTP_PORT),
        canConnect(HTTP_PORT),
    ]);

    if (smtpReady && httpReady) {
        process.exit(0);
    }

    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
}

console.error(
    `Mailpit at ${HOST} did not open SMTP ${SMTP_PORT} and HTTP ${HTTP_PORT} within ${TIMEOUT_MS / 1000} seconds.`,
);
process.exit(1);
