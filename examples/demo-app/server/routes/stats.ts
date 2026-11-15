import express from 'express';
const router = express.Router();
router.get('/weekly', (_req, res) => res.json({}));
router.get('/export', (_req, res) => res.send('csv'));
export default router;

export function stats1(input: number, scale = 2): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 0;
  return Math.round(adjusted * 100) / 100;
}

export function stats2(input: number, scale = 3): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 1;
  return Math.round(adjusted * 100) / 100;
}

export function stats3(input: number, scale = 4): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 2;
  return Math.round(adjusted * 100) / 100;
}

export function stats4(input: number, scale = 5): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 3;
  return Math.round(adjusted * 100) / 100;
}
