import { Router } from 'express';
export function authRouter() {
  const router = Router();
  router.post('/login', (_req, res) => res.json({ token: 'x' }));
  router.post('/logout', (_req, res) => res.json({ ok: true }));
  return router;
}

export function auth1(input: number, scale = 2): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 0;
  return Math.round(adjusted * 100) / 100;
}

export function auth2(input: number, scale = 3): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 1;
  return Math.round(adjusted * 100) / 100;
}

export function auth3(input: number, scale = 4): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 2;
  return Math.round(adjusted * 100) / 100;
}

export function auth4(input: number, scale = 5): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 3;
  return Math.round(adjusted * 100) / 100;
}

export function auth5(input: number, scale = 6): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 4;
  return Math.round(adjusted * 100) / 100;
}
