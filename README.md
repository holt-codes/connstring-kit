# connstring-kit

A parser for URI-style database connection strings
(`postgres://user:pass@host:5432/db?sslmode=require`) that is strict by
default, plus a thin CLI on top.

## Why

Connection strings look like URLs but nothing enforces that they actually
are one. In practice you end up with strings that have a port of `0`, a
query string with the same key twice, a username with unescaped characters,
or no host at all — and most parsers I've used either throw an unhelpful
error deep in a driver, or silently pick one interpretation and move on.

This library picks one behavior and makes it the default: if something
about the string is ambiguous or wrong, `parseConnectionString` throws a
`ConnectionStringError` that says exactly what field it didn't like. If you
need to accept messy input anyway — logs, user-pasted strings, old config
files — you opt into that explicitly with `{ lenient: true }` (or `--lenient`
on the CLI). Nothing is lenient by accident.

## Install

There's no published package yet. Clone the repo and build it:

```
npm install --save-dev typescript
npm run build
```

## Library usage

```ts
import { parseConnectionString, ConnectionStringError } from './dist/index.js';

const parsed = parseConnectionString(
  'postgres://app_user:hunter2@db.internal:5432/orders?sslmode=require'
);

// {
//   scheme: 'postgres',
//   username: 'app_user',
//   password: 'hunter2',
//   hosts: [{ host: 'db.internal', port: 5432 }],
//   database: 'orders',
//   params: { sslmode: 'require' },
//   raw: 'postgres://app_user:hunter2@db.internal:5432/orders?sslmode=require'
// }

try {
  parseConnectionString('postgres://db.internal:99999/orders');
} catch (err) {
  if (err instanceof ConnectionStringError) {
    console.error(err.code, err.message); // "invalid-port", "port 99999 for host ... is out of range"
  }
}

// Same malformed input, but you've decided to accept it anyway:
const relaxed = parseConnectionString('postgres://db.internal:99999/orders', { lenient: true });
// relaxed.hosts[0].port === null — the bad port is dropped instead of raising
```

Multi-host strings (replica sets, cluster endpoints) are supported directly:

```ts
parseConnectionString('mongodb://alice:s3cr3t@host1:27017,host2:27017/analytics?replicaSet=rs0');
// hosts: [{ host: 'host1', port: 27017 }, { host: 'host2', port: 27017 }]
```

`redactConnectionString` parses a string and hands back a version with the
password masked, for logging:

```ts
import { redactConnectionString } from './dist/index.js';

redactConnectionString('mysql://root:hunter2@127.0.0.1:3306/app');
// 'mysql://root:****@127.0.0.1:3306/app'
```

## CLI usage

```
node dist/cli.js parse 'postgres://app_user:hunter2@db.internal:5432/orders?sslmode=require'
node dist/cli.js redact 'mysql://root:hunter2@127.0.0.1:3306/app'
node dist/cli.js parse 'redis://:5432/0' --lenient
```

`parse` prints the parsed structure as JSON; `redact` prints the string back
out with the password masked. Any parse error without `--lenient` exits
non-zero and prints which rule was violated.

## What "strict" currently checks

- a `scheme://` prefix is required
- at least one host is required
- ports must be integers in the range 1–65535
- percent-encoded fields (username, password, database, query values) must
  decode cleanly
- query strings may not repeat the same key twice

Each of these is relaxed under `--lenient` / `{ lenient: true }`, and it
recovers with a reasonable default (dropping a bad port, keeping the last
value of a repeated key, and so on) rather than guessing silently.

## License

MIT, see [LICENSE](LICENSE).
