# dfhack-remote-node

A small, strictly-typed Node client for the [DFHack](https://github.com/DFHack/dfhack)
Remote RPC protocol — protobuf over raw TCP (`127.0.0.1:5000`). It lets a Node
process read from (and, later, act on) a live Dwarf Fortress fort without
compiling against DFHack's C++.

This is a TypeScript port of the original browser client
([alexchandel/dfhack-remote](https://github.com/alexchandel/dfhack-remote), ISC).
The protocol codec is carried over; the transport was rewritten from
WebSocket + `websockify` to Node `net.Socket`, `RunCommand` console output is now
captured instead of discarded, and methods bind lazily on first use.

Built primarily as the RPC layer for a DFHack MCP server.

## Install

```sh
npm install dfhack-remote-node
```

Requires **Node 20 or newer** — that is what `dist/` is compiled for.

The published package ships prebuilt (`dist/` ESM + type declarations, proto
bundle inlined), so no build step is needed to consume it.

To work on the library from a clone instead:

```sh
npm install
npm run build     # regenerates build/proto.json and bundles dist/
```

Developing on a clone needs **Node 24** (see `.nvmrc`). That is a stricter bar
than consuming the package: the tests run the TypeScript sources directly via
type-stripping and JSON import attributes, which need Node 23.6+.

`build/proto.json` (the compiled protobuf bundle) is committed, so the source
runs immediately; `npm run build` produces the distributable `dist/` (ESM +
type declarations, with the proto bundle inlined).

## Usage

```js
import { DwarfClient } from 'dfhack-remote-node';

const df = new DwarfClient(); // defaults to 127.0.0.1:5000
await df.connect(); // handshake

console.log(await df.getVersion()); // DFHack version string
const world = await df.getWorldInfo(); // decoded GetWorldInfoOut
console.log(world.worldName?.englishName);

// Arbitrary Lua snippet; returns whatever it prints (captured console output):
const text = await df.runLuaSnippet('print(#df.global.world.units.active)');

// Any method in the METHODS table, by name:
const map = await df.call('GetMapInfo');

df.close();
```

Every reply object also carries `_text` — the concatenated console output from
any TEXT frames the call produced.

## Package layout

`src/` is split by concern (all TypeScript ESM):

| File            | Responsibility                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| `codec.ts`      | wire framing: magic bytes, frame ids, `encodeMessage`, `readHandshake`, `readFrame` |
| `errors.ts`     | `RpcError`, `ProtocolError`                                                         |
| `connection.ts` | `DfConnection` — the `net.Socket` transport + call queue                            |
| `methods.ts`    | the `METHODS` table (fully-qualified protobuf type names)                           |
| `proto.ts`      | loads the committed proto bundle as a JSON module import                            |
| `client.ts`     | `DwarfClient` — the high-level API                                                  |
| `index.ts`      | public exports                                                                      |

The source imports the proto bundle as a JSON module
(`import protoJson from '../build/proto.json' with { type: 'json' }`), so the
bundler inlines it into `dist/` — there is no runtime file lookup.

## Protos

> The `.proto` files are pinned to **DFHack `53.15-r2`** (pulled from
> [DFHack/dfhack](https://github.com/DFHack/dfhack) at the commit the running
> build reports via `getGitDescription`). To retarget another version, replace
> the files from the matching tag and re-run `npm run gen-proto`. Method
> input/output types in `METHODS` (`src/methods.ts`) are fully-qualified names
> that must match DFHack's registration, or `BindMethod` reports a "wrong
> signature" at runtime — which makes drift detectable per method.

## Scripts

```sh
npm run build       # gen-proto + tsup -> dist/ (ESM + .d.ts, proto inlined)
npm run gen-proto   # regenerate build/proto.json from proto/*.proto
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (flat config)
npm run format      # prettier --write
npm test            # offline: mock server speaks the real wire format, no game needed
npm run spike       # live: connect to a running fort, print version + world + fort name
```

`npm test` validates handshake, framing, lazy binding, protobuf round-trip, and
TEXT-frame capture against an in-process mock. `npm run spike` (M0) requires
Dwarf Fortress running with DFHack and a fort loaded.

## Protocol notes

- Handshake: client sends `DFHack?\n` + `i32(1)`, server replies `DFHack!\n` + `i32(1)`.
- Message header: `id:i16, pad:u16, size:i32` (little-endian), then `size` body bytes.
- A call's reply is zero or more `TEXT` frames (console output) followed by one
  `RESULT` frame (reply protobuf) or one `FAIL` frame (errno in the size field).
- Calls are serialized — DFHack handles one at a time per socket.
- `GetBlockList` only returns blocks _changed since the last call_ — don't build a
  full-map snapshot on it naively (use `ResetMapHashes` to force a resend).

## Contributing

Issues and PRs welcome. Please keep the module boundaries above intact, run
`npm run typecheck`, `npm run lint`, and `npm test` before opening a PR, and add
new RPC methods to `src/methods.ts` with their fully-qualified protobuf type
names. Changes touching the live protocol should be verified against a running
fort with `npm run spike`.

## License

ISC. Ported from [alexchandel/dfhack-remote](https://github.com/alexchandel/dfhack-remote)
(Copyright © 2020 Alexander Chandel); the original copyright and license are
preserved in [LICENSE.md](./LICENSE.md).
