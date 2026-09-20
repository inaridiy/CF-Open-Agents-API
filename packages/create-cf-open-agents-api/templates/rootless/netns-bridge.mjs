// Forwards TCP connections across a network namespace boundary through a Unix socket,
// which both namespaces can open. dev-rootless.sh runs one copy on the host
// (tcp-to-unix) and one inside rootlesskit's namespace (unix-to-tcp).
// Added by create-cf-open-agents-api; a temporary workaround until Wrangler supports
// rootless Docker engines.
import { rmSync } from "node:fs";
import net from "node:net";

const [mode, listenOn, connectTo] = process.argv.slice(2);

// Half-open connections are relayed as such: `pipe` ends the peer's write side when a
// side finishes writing, so a client that closes its write side after the request still
// receives the reply. Both sockets are torn down once either one fully closes or fails.
function relay(socket, peer) {
  socket.pipe(peer);
  peer.pipe(socket);
  const close = () => {
    socket.destroy();
    peer.destroy();
  };
  socket.on("error", close).on("close", close);
  peer.on("error", close).on("close", close);
}

function exitOnSignal(cleanup) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
}

/** One line on stdout once the server listens; the tests and the shell script wait for it. */
function announce(server, label) {
  server.on("listening", () => {
    const address = server.address();
    const where = typeof address === "string" ? address : `${address.address}:${address.port}`;
    console.log(`netns-bridge: ${label} listening on ${where}`);
  });
  server.on("error", (error) => {
    console.error(`netns-bridge: ${label}: ${error.message}`);
    process.exit(1);
  });
}

if (mode === "tcp-to-unix" && listenOn && connectTo) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) =>
    relay(socket, net.connect({ path: connectTo, allowHalfOpen: true })),
  );
  announce(server, mode);
  server.listen(Number(listenOn), "127.0.0.1");
  exitOnSignal(() => {});
} else if (mode === "unix-to-tcp" && listenOn && connectTo) {
  rmSync(listenOn, { force: true }); // a previous run may have left the file behind
  const server = net.createServer({ allowHalfOpen: true }, (socket) =>
    relay(socket, net.connect({ port: Number(connectTo), host: "127.0.0.1", allowHalfOpen: true })),
  );
  announce(server, mode);
  server.listen(listenOn);
  exitOnSignal(() => rmSync(listenOn, { force: true }));
} else {
  console.error(
    "usage: netns-bridge.mjs tcp-to-unix <port> <socket> | unix-to-tcp <socket> <port>",
  );
  process.exit(2);
}
