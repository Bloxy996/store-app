// Vercel serverless entrypoint. Vercel's Node runtime treats a default-
// exported Express app as a request handler directly — no .listen() call,
// no extra adapter package needed. See ../src/app.js for the actual
// routes/middleware (shared with the Render/plain-Node entrypoint at
// ../src/index.js so the two hosting paths can't drift apart).
//
// This function is stateless between invocations (no in-memory anything
// survives a cold start) — already how this backend is written, since the
// only server-side state is the encrypted session cookie held in the
// browser (server/src/session.js). One thing this does NOT cover: the
// Python service (server/python/) behind /api/statements/* and
// /api/music/* still needs to run somewhere with a persistent, warm
// process (see that folder's README — the embedding model has to stay
// loaded in memory, and it's well past what fits in a serverless
// function's size/warm-start budget). Point STATEMENTS_SERVICE_URL at
// wherever that's hosted; it doesn't have to be Vercel.
import { createApp } from '../src/app.js';

const app = createApp();

export default app;
