import { query } from './_generated/server';
export const me = query({ handler: async (ctx) => ctx.db.query('users').first() });
