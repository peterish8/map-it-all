import { requireNativeModule } from 'expo-modules-core';
export const HabitWidget = requireNativeModule('HabitWidget');
export const Notifier = requireNativeModule('Notifier');
export const weekly = () => fetch("/api/stats/weekly");
