export const fetchHabits = () => fetch("/api/habits");
export const addHabit = (title: string) => fetch("/api/habits", { method: "POST", body: title });
export const deleteHabit = (id: string) => fetch(`/api/habits/${encodeURIComponent(id)}`, { method: "DELETE" });
export const apiLogin = () => fetch("/api/auth/login", { method: "POST" });
export const apiLogout = () => fetch("/api/auth/logout", { method: "POST" });

export function net1(input: number, scale = 2): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 0;
  return Math.round(adjusted * 100) / 100;
}

export function net2(input: number, scale = 3): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 1;
  return Math.round(adjusted * 100) / 100;
}

export function net3(input: number, scale = 4): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 2;
  return Math.round(adjusted * 100) / 100;
}

export function net4(input: number, scale = 5): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 3;
  return Math.round(adjusted * 100) / 100;
}

export function net5(input: number, scale = 6): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 4;
  return Math.round(adjusted * 100) / 100;
}

export function net6(input: number, scale = 7): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 5;
  return Math.round(adjusted * 100) / 100;
}
