import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from './types.ts';
export type Capability = { projectId: string; role: Role; exp: number; entitlementId?: string };
export function sign(secret: string, payload: Omit<Capability, 'exp'>, hours = 24) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + hours * 3600000 })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verify(secret: string, token: string): Capability {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new Error('This access link is invalid. Ask the seller for a new link.');
  const actual = Buffer.from(signature, 'base64url');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('This access link is invalid.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!payload.projectId || !['seller', 'client', 'download'].includes(payload.role) || !Number.isFinite(payload.exp) || payload.exp < Date.now()) throw new Error('This access link expired. Ask the seller for a new link.');
  return payload;
}
