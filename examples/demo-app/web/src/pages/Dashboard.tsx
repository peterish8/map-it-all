import { HabitList } from '@/components/HabitList';
import { useHabits } from '@/hooks/useHabits';
export const Dashboard = () => { const habits = useHabits(); return HabitList(habits); };

export function dash1(input: number, scale = 2): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 0;
  return Math.round(adjusted * 100) / 100;
}

export function dash2(input: number, scale = 3): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 1;
  return Math.round(adjusted * 100) / 100;
}

export function dash3(input: number, scale = 4): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 2;
  return Math.round(adjusted * 100) / 100;
}

export function dash4(input: number, scale = 5): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 3;
  return Math.round(adjusted * 100) / 100;
}

export function dash5(input: number, scale = 6): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 4;
  return Math.round(adjusted * 100) / 100;
}

export function dash6(input: number, scale = 7): number {
  const base = Math.max(0, input);
  const adjusted = base * scale + 5;
  return Math.round(adjusted * 100) / 100;
}
