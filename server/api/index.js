// Vercel serverless entrypoint. Vercel's Node runtime treats a default-
// exported Express app as a request handler directly — no .listen() call,
// no extra adapter package needed. See ../src/app.js for the actual
// routes/middleware (shared with the Render/plain-Node entrypoint at
// ../src/index.js so the two hosting paths can't drift apart).
//
// This function is stateless between invocations (no in-memory anything
// survives a cold start) — already how this backend is written, since the
// only server-side state is the encrypted session cookie held in the
// browser (server/src/session.js). There used to be a caveat here about a
// separate Python process (server/python/) behind /api/statements/*
// needing its own persistent host, since a serverless function can't keep
// an embedding model warm — that's gone; the Statements spark category
// now runs entirely client-side (src/lib/statementsEngine.js and
// friends), so this function has no route left that needs anything more
// than a cold start.
import { createApp } from '../src/app.js';

const app = createApp();

export default app;
