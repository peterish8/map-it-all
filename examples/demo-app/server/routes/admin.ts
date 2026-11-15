import { Router } from 'express';
export function adminRouter() {
  const router = Router();
  router.get('/users', (_req, res) => res.json([]));
  router.post('/reindex', (_req, res) => res.json({}));
  return router;
}
