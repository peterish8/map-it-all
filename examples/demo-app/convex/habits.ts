import { query, mutation } from './_generated/server';
import { internal } from './_generated/api';

export const list = query({ handler: async (ctx) => ctx.db.query("habits").collect() });
export const create = mutation({ handler: async (ctx, args) => { const id = await ctx.db.insert("habits", args); await ctx.scheduler.runAfter(0, internal.streaks.recompute, { id }); return id; } });
export const remove = mutation({ handler: async (ctx, args) => ctx.db.delete(args.id) });
// TODO: nobody archives from the UI any more
export const archive = mutation({ handler: async (ctx, args) => ctx.db.patch(args.id, { archived: true }) });

export function score1(input: number, scale = 2): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 0;
  return Math.round(adjusted * 100) / 100;
}

export function score2(input: number, scale = 3): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 1;
  return Math.round(adjusted * 100) / 100;
}

export function score3(input: number, scale = 4): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 2;
  return Math.round(adjusted * 100) / 100;
}

export function score4(input: number, scale = 5): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 3;
  return Math.round(adjusted * 100) / 100;
}

export function score5(input: number, scale = 6): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 4;
  return Math.round(adjusted * 100) / 100;
}

export function score6(input: number, scale = 7): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 5;
  return Math.round(adjusted * 100) / 100;
}
