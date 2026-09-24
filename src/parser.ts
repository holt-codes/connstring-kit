export interface HostPort {
  host: string;
  port: number | null;
}

export interface ParsedConnectionString {
  scheme: string;
  username: string | null;
  password: string | null;
  hosts: HostPort[];
  database: string | null;
  params: Record<string, string>;
  raw: string;
}

export interface ParseOptions {
  /** Tolerate malformed input instead of throwing. Off by default on purpose. */
  lenient?: boolean;
}

export class ConnectionStringError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectionStringError';
    this.code = code;
  }
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
// host is either a bracketed IPv6 literal or anything but ':' and ',', with an optional port.
const HOST_PORT_RE = /^(\[[^\]]+\]|[^:,]+)(?::(\d*))?$/;

interface SchemeRule {
  defaultPort?: number;
  requireDatabase?: boolean;
}

// Rules for schemes common enough to be worth checking. Unknown schemes get
// no default port and no database requirement, same as before this existed.
const SCHEME_RULES: Record<string, SchemeRule> = {
  postgres: { defaultPort: 5432, requireDatabase: true },
  postgresql: { defaultPort: 5432, requireDatabase: true },
  mysql: { defaultPort: 3306, requireDatabase: true },
  mongodb: { defaultPort: 27017 },
  redis: { defaultPort: 6379 },
  rediss: { defaultPort: 6379 },
};

function fail(lenient: boolean, code: string, message: string): void {
  if (!lenient) {
    throw new ConnectionStringError(code, message);
  }
}

function decodeComponent(value: string, lenient: boolean, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(lenient, 'bad-percent-encoding', `${field} contains invalid percent-encoding: ${value}`);
    return value;
  }
}

/**
 * Parses a URI-style connection string such as
 * "postgres://user:pass@host:5432/db?sslmode=require".
 *
 * Strict by default: the first thing that looks wrong (missing scheme,
 * out-of-range port, duplicate query key, unparseable percent-encoding,
 * ...) throws a ConnectionStringError. Pass { lenient: true } to keep
 * going and do a best-effort parse instead.
 */
export function parseConnectionString(input: string, options: ParseOptions = {}): ParsedConnectionString {
  const lenient = options.lenient === true;
  const raw = input;

  const schemeMatch = SCHEME_RE.exec(input);
  let scheme = '';
  let rest = input;

  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = input.slice(schemeMatch[0].length);
  } else {
    fail(lenient, 'missing-scheme', `connection string is missing a "scheme://" prefix: ${input}`);
  }

  let beforeQuery = rest;
  let queryPart = '';
  const queryIndex = rest.indexOf('?');
  if (queryIndex !== -1) {
    beforeQuery = rest.slice(0, queryIndex);
    queryPart = rest.slice(queryIndex + 1);
  }

  let authorityAndPath = beforeQuery;
  let username: string | null = null;
  let password: string | null = null;

  // Userinfo can't contain '@', so the last '@' before the path is the separator
  // between it and the host list (a password itself might contain '@' once decoded).
  const atIndex = beforeQuery.lastIndexOf('@');
  if (atIndex !== -1) {
    const userinfo = beforeQuery.slice(0, atIndex);
    authorityAndPath = beforeQuery.slice(atIndex + 1);
    const colonIndex = userinfo.indexOf(':');
    if (colonIndex === -1) {
      username = decodeComponent(userinfo, lenient, 'username');
    } else {
      username = decodeComponent(userinfo.slice(0, colonIndex), lenient, 'username');
      password = decodeComponent(userinfo.slice(colonIndex + 1), lenient, 'password');
    }
    if (username === '') {
      fail(lenient, 'empty-username', 'username is present but empty');
      username = null;
    }
  }

  const slashIndex = authorityAndPath.indexOf('/');
  let hostSection = authorityAndPath;
  let database: string | null = null;
  if (slashIndex !== -1) {
    hostSection = authorityAndPath.slice(0, slashIndex);
    const dbRaw = authorityAndPath.slice(slashIndex + 1);
    database = dbRaw === '' ? null : decodeComponent(dbRaw, lenient, 'database');
  }

  const hosts = parseHostList(hostSection, lenient);
  if (hosts.length === 0) {
    fail(lenient, 'missing-host', `connection string has no host: ${input}`);
  }

  const rule = SCHEME_RULES[scheme];
  if (rule) {
    if (rule.defaultPort !== undefined) {
      for (const host of hosts) {
        if (host.port === null) {
          host.port = rule.defaultPort;
        }
      }
    }
    if (rule.requireDatabase && !database) {
      fail(lenient, 'missing-database', `${scheme} connection strings require a database name: ${input}`);
    }
  }

  const params = parseQuery(queryPart, lenient);

  return { scheme, username, password, hosts, database, params, raw };
}

function parseHostList(section: string, lenient: boolean): HostPort[] {
  if (section === '') {
    return [];
  }
  const hosts: HostPort[] = [];
  for (const part of section.split(',')) {
    if (part === '') {
      fail(lenient, 'empty-host-entry', `host list has an empty entry: ${section}`);
      continue;
    }
    const match = HOST_PORT_RE.exec(part);
    if (!match) {
      fail(lenient, 'malformed-host', `could not parse host/port from: ${part}`);
      if (lenient) {
        hosts.push({ host: part, port: null });
      }
      continue;
    }
    const host = match[1];
    let port: number | null = null;
    if (match[2] !== undefined) {
      if (match[2] === '') {
        fail(lenient, 'malformed-port', `host "${host}" has a trailing colon with no port`);
      } else {
        const parsedPort = Number(match[2]);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          fail(lenient, 'invalid-port', `port ${match[2]} for host "${host}" is out of range`);
        } else {
          port = parsedPort;
        }
      }
    }
    hosts.push({ host, port });
  }
  return hosts;
}

function parseQuery(query: string, lenient: boolean): Record<string, string> {
  const params: Record<string, string> = {};
  if (query === '') {
    return params;
  }
  for (const pair of query.split('&')) {
    if (pair === '') {
      continue;
    }
    const eqIndex = pair.indexOf('=');
    const rawKey = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);
    const key = decodeComponent(rawKey, lenient, 'query key');
    const value = decodeComponent(rawValue, lenient, 'query value');
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      fail(lenient, 'duplicate-param', `query parameter "${key}" is repeated`);
    }
    params[key] = value;
  }
  return params;
}

/** Serializes a parsed connection string back into its URI form. */
export function formatConnectionString(parsed: ParsedConnectionString): string {
  let out = '';
  if (parsed.scheme) {
    out += `${parsed.scheme}://`;
  }
  if (parsed.username !== null) {
    out += encodeURIComponent(parsed.username);
    if (parsed.password !== null) {
      out += `:${encodeURIComponent(parsed.password)}`;
    }
    out += '@';
  }
  out += parsed.hosts.map((h) => (h.port !== null ? `${h.host}:${h.port}` : h.host)).join(',');
  if (parsed.database !== null) {
    out += `/${encodeURIComponent(parsed.database)}`;
  }
  const keys = Object.keys(parsed.params);
  if (keys.length > 0) {
    out += '?' + keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(parsed.params[k])}`).join('&');
  }
  return out;
}

/** Parses a connection string and returns it with the password (if any) masked out. */
export function redactConnectionString(input: string, options: ParseOptions = {}): string {
  const parsed = parseConnectionString(input, options);
  if (parsed.password !== null) {
    parsed.password = '****';
  }
  return formatConnectionString(parsed);
}

export interface ConnectionStringParts {
  scheme: string;
  username?: string | null;
  password?: string | null;
  hosts: HostPort[];
  database?: string | null;
  params?: Record<string, string>;
}

/**
 * Builds a connection string from parts, applying the same strict-by-default
 * checks as parseConnectionString (a scheme is required, at least one host
 * is required, ports must be in range, schemes that require a database get
 * one). Unlike parseConnectionString, the inputs here are already-decoded
 * values, not raw URI text, so they're percent-encoded on the way out rather
 * than decoded on the way in.
 */
export function buildConnectionString(parts: ConnectionStringParts, options: ParseOptions = {}): string {
  const lenient = options.lenient === true;

  let scheme = parts.scheme;
  if (!scheme) {
    fail(lenient, 'missing-scheme', 'a scheme is required to build a connection string');
    scheme = '';
  } else {
    scheme = scheme.toLowerCase();
  }

  let username = parts.username ?? null;
  if (username === '') {
    fail(lenient, 'empty-username', 'username is present but empty');
    username = null;
  }
  const password = parts.password ?? null;
  if (password !== null && username === null) {
    fail(lenient, 'password-without-username', 'password given without a username');
  }

  if (parts.hosts.length === 0) {
    fail(lenient, 'missing-host', 'connection string has no host');
  }

  const hosts: HostPort[] = parts.hosts.map((h) => {
    let port = h.port;
    if (port === undefined) {
      port = null;
    } else if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      fail(lenient, 'invalid-port', `port ${port} for host "${h.host}" is out of range`);
      port = null;
    }
    return { host: h.host, port };
  });

  const rule = SCHEME_RULES[scheme];
  if (rule) {
    if (rule.defaultPort !== undefined) {
      for (const host of hosts) {
        if (host.port === null) {
          host.port = rule.defaultPort;
        }
      }
    }
    if (rule.requireDatabase && !parts.database) {
      fail(lenient, 'missing-database', `${scheme} connection strings require a database name`);
    }
  }

  return formatConnectionString({
    scheme,
    username,
    password,
    hosts,
    database: parts.database ?? null,
    params: parts.params ?? {},
    raw: '',
  });
}
