import { httpRouter } from 'convex/server';
const http = httpRouter();
http.route({ path: '/webhook/push', method: 'POST', handler: async () => new Response('ok') });
export default http;
