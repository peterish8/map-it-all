import express from 'express';
import { authRouter } from './routes/auth';
import { habitsRouter } from './routes/habits';
import statsRouter from './routes/stats';
import { adminRouter } from './routes/admin';

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter());
app.use('/api/habits', habitsRouter());
app.use('/api/stats', statsRouter);
if (process.env.ADMIN_ENABLED) app.use('/api/admin', adminRouter());
export default app;
