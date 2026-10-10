// One message to ENODIA_WEBHOOK_URL. The body carries both "content" (Discord) and "text" (Slack and
// most others), so the same URL works for either.
import http from 'node:http';
import https from 'node:https';
import { config } from './config.mjs';

export function postWebhook(text) {
  if (!config.webhookUrl) return;
  const name = config.instanceName || 'Traefik';
  const body = JSON.stringify({ content: `**Enodia · ${name}**\n${text}`.slice(0, 1990), text: `Enodia · ${name}\n${text}` });
  const u = new URL(config.webhookUrl);
  const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
  req.on('error', (e) => console.error('[enodia] webhook failed:', e.message));
  req.end(body);
}
