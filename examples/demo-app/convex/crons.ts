import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval('reminders', { minutes: 15 }, internal.reminders.sendDue);
export default crons;
