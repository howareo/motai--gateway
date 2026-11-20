import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../src/server.js';
import { GatewayClient } from '../../src/gateway/client.js';
import { ConfigPublisher } from '../../src/gateway/config-publisher.js';
import { GatewayControl } from '../../src/gateway/control.js';

const directory = process.env.MOTAI_GATEWAY_CONFIG_DIR;
if (!directory || !process.env.MOTAI_GATEWAY_INTERNAL_URL) throw new Error('Isolated config directory and gateway URL required');
const client = new GatewayClient({ baseUrl: process.env.MOTAI_GATEWAY_INTERNAL_URL,
  managementToken: await readFile(path.join(directory, 'management.key'), 'utf8') });
const publisher = new ConfigPublisher({ directory, client,
  callerHashKey: await readFile(path.join(directory, 'hmac.key')),
  forbiddenTargets: [process.env.MOTAI_GATEWAY_INTERNAL_URL, ...(process.env.MOTAI_GATEWAY_MODEL_URL ? [process.env.MOTAI_GATEWAY_MODEL_URL] : [])] });
export const app = createApp({ gatewayControl: new GatewayControl({ client, publisher }) });
await app.start();
console.log(JSON.stringify({ mode: 'gateway-candidate', address: app.server.address(), production: false }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
