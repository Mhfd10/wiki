# Historical page URLs

Moving a page reserves its old path and locale as a redirect to the page ID.
Repeated moves resolve directly to the current path. A real page takes precedence
over a historical redirect. HTTP redirects use status 302 and `Cache-Control:
no-store`, preserve query parameters, and check read access at the destination.
Rendered internal links preserve query strings and fragments and are tracked
against the current destination. Deleting the target removes its redirects.

Destination claims lock the locale row before checking page and redirect paths.
This also serializes claims for unused URLs: upstream's pages table has no unique
path constraint. Concurrent create/move operations within one locale may wait or
fail with a database contention error; retry after checking the current state.

## Migration and compatibility

Migration `2.5.129` creates `pageRedirects` in the shared and SQLite migration
sets. The identifier follows upstream `2.5.128`; check that it is still available
before merging. The migration backfills `moved` history entries, newest first,
for surviving pages. Active page paths are excluded; the latest eligible move
wins when multiple pages have used a path. Other history actions are excluded.

Backfill loads page history and current page identities into memory, then inserts
redirects in batches of 100. Measure startup time and memory on a representative
large database before rollout. No previously existing page content is modified.

The down migration drops only the redirect table. It does not undo page moves,
reconstruct historical URLs, or reverse subsequent content edits. Back up before
upgrading and use a database restore for a complete application/data rollback.

The original custom fork used this same migration name and table definition.
Do not rename or edit an already applied migration on a deployed database.
If upstream needs a different migration number or schema, prepare an explicit
compatibility migration for those installations before upgrading them.

## Validation

Use the Node version in `.nvmrc`, install the locked Yarn dependencies, and run:

```sh
yarn jest --runInBand server/test
yarn test
yarn build
```

The server suite runs SQLite integration tests, including the real migration.
The migration integration test can also run against an empty dedicated database:

```sh
WIKI_TEST_DB=postgres WIKI_TEST_DB_URL=postgres://USER:PASSWORD@localhost:5432/wiki_contribution_test yarn jest --runInBand server/test/db/migrations/page-redirects.integration.test.js
```

Use `WIKI_TEST_DB=mysql` or `mariadb` with a `mysql://` URL for those engines.
Only the database name `wiki_contribution_test` is accepted, and the test refuses
pre-existing `pages`, `pageHistory`, or `pageRedirects` tables. Tests create and
remove their own tables. Do not point these commands at an application database.
The same environment variables run the separate-connection path-claim tests in
`server/test/integration/page-path-concurrency.test.js`.

Database writes commit before rendering, search, storage, and cache work.
A synchronization error can therefore be reported after a move has committed.
Check the current page state before retrying; a reported error is not proof of
rollback. This series preserves that existing post-commit failure behavior.
