# Habitly agent notes

- Habit data is in `convex/habits.ts`; streaks are recomputed in `convex/streaks.ts`.
- Never call `convex/legacyImport.ts` from the app, it exists for one old client.
- The widget bridge is `mobile/android/app/src/main/java/app/HabitWidgetModule.kt`.
- Old notes: `docs/migration-2024.md`.
