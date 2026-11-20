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
  // Ceilings on the whole app, so nobody can fill the account's storage through one page: all its
  // answers together, and its history (the oldest changes are dropped once it passes either figure).
  maxStateBytes: 8 * 1024 * 1024,
  maxHistoryBytes: 16 * 1024 * 1024,
  maxHistoryRows: 50000,
  maxBodyBytes: 256 * 1024,
  maxSockets: 1000,
  // Files live in the app's Durable Object, cut into pieces. A SQLite row there can hold a few MB;
  // 1 MB pieces stay well inside that, and inside the free plan's processor time per request.
  pieceBytes: 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxAppBytes: 250 * 1024 * 1024,
  maxFiles: 2000,
  // Sign-ups: named things with a fixed number of places.
  limitPattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/,
  maxLimits: 200,
  maxPlaces: 100000,
  maxNote: 1000,
  bookingsPerIpPerDay: 20,
};

export const SESSION_DAYS = 30;
export const VISITOR_DAYS = 400; // browsers cap cookie lifetimes at about this
