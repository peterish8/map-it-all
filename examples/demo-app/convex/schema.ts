import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  users: defineTable({ name: v.string(), email: v.string() }),
  habits: defineTable({ userId: v.id("users"), title: v.string(), archived: v.boolean() }),
  streaks: defineTable({ habitId: v.id("habits"), days: v.number() }),
  auditLog: defineTable({ at: v.number(), message: v.string() }),
});
