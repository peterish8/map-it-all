import { mutation } from './_generated/server';

// Kept for one old mobile build.
export const run = mutation({ handler: async (ctx, args) => ctx.db.insert("habits", args) });

export function legacy1(input: number, scale = 2): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 0;
  return Math.round(adjusted * 100) / 100;
}

export function legacy2(input: number, scale = 3): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 1;
  return Math.round(adjusted * 100) / 100;
}

export function legacy3(input: number, scale = 4): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 2;
  return Math.round(adjusted * 100) / 100;
}

export function legacy4(input: number, scale = 5): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 3;
  return Math.round(adjusted * 100) / 100;
}

export function legacy5(input: number, scale = 6): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 4;
  return Math.round(adjusted * 100) / 100;
}
