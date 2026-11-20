// Names, sizes and ceilings shared by the Worker and the Durable Objects.

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// App files must not shadow the Worker's own routes (_login, _api …), so no path part starts with "_".
export const FILE_RE = /^(?!_)(?!.*\/_)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,300}$/;
export const VISITOR_RE = /^[0-9a-f-]{36}$/;

export const LIMITS = {
  keyPattern: /^[A-Za-z0-9_.:\/-]{1,200}$/,
  maxValueBytes: 64 * 1024,
  maxKeys: 5000,
  maxAuthor: 80,
  // Private apps: one set of answers per visitor, so the caps are per visitor plus a ceiling overall.
  maxKeysPerVisitor: 500,
  maxPrivateRows: 20000,
  // Files live in the app's Durable Object, cut into pieces. A SQLite row there can hold a few MB;
  // 1 MB pieces stay well inside that, and inside the free plan's processor time per request.
  pieceBytes: 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxAppBytes: 250 * 1024 * 1024,
  maxFiles: 2000,
};

export const SESSION_DAYS = 30;
export const VISITOR_DAYS = 400; // browsers cap cookie lifetimes at about this
