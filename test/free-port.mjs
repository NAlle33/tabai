import { createServer } from "node:net";

/** Reserve distinct loopback ports together, then release them for this test. */
export async function allocatePorts(count) {
  const servers = [];
  try {
    const ports = [];
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      ports.push(String(server.address().port));
    }
    return ports;
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}
