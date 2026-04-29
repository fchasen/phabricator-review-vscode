# phabricator-client

Vanilla-JavaScript client for the [Mozilla Phabricator Conduit API][conduit].

Independent of the [`vscode-phab`][vscode-phab] extension that consumes it; intended to be extractable as its own npm package.

## Install

```sh
npm install phabricator-client
```

Requires Node 18+ (or any environment with a global `fetch`).

## Usage

```js
const { PhabricatorClient } = require('phabricator-client');

const client = new PhabricatorClient({
  token: process.env.PHAB_TOKEN, // from https://phabricator.services.mozilla.com/conduit/login
  baseUrl: 'https://phabricator.services.mozilla.com/api/',
});

const me = await client.whoami();

for await (const revision of client.searchRevisions({ authorPHIDs: [me.phid] })) {
  console.log(revision.id, revision.fields.title);
}
```

## API

See [`src/client.js`](src/client.js) for the full surface. JSDoc types are emitted to `dist-types/` via `npm run build:types`.

## Token

Get a Conduit API token at <https://phabricator.services.mozilla.com/conduit/login>. Tokens are bearer credentials — do not commit them.

[conduit]: https://phabricator.services.mozilla.com/conduit/
[vscode-phab]: ../README.md
