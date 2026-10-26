// Offline connection lifecycle test. Fake sockets let each test control event
// order precisely: an old socket's error, late close, and repeated events can
// be delivered after a replacement socket has connected.
//
// Fail closed: the process exit code starts at 1 and is only cleared after
// every check has run. Each awaited promise is settled under a timeout, and a
// watchdog fails the run if a stuck await or a leaked handle keeps it going, so
// a regression can never print FAIL lines and still exit 0.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { setTimeout as setTimer, clearTimeout } from 'node:timers';
import { DfConnection } from '../src/connection.ts';
import { DwarfClient } from '../src/client.ts';
import { HANDSHAKE_LEN, REQUEST_MAGIC, RESPONSE_MAGIC } from '../src/codec.ts';

const COMPLETE_RESPONSE_MAGIC = Buffer.alloc(HANDSHAKE_LEN);
RESPONSE_MAGIC.copy(COMPLETE_RESPONSE_MAGIC);
COMPLETE_RESPONSE_MAGIC.writeInt32LE(1, RESPONSE_MAGIC.length);

/** How long a single awaited lifecycle event may take before it is a failure. */
const SETTLE_TIMEOUT_MS = 1000;
/** Whole-suite watchdog: a hung await must still fail the process. */
const HARNESS_TIMEOUT_MS = 30000;

class FakeSocket extends EventEmitter {
  writes = [];
  ended = false;
  destroyedWith = null;

  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end() {
    this.ended = true;
    return this;
  }

  destroy(err) {
    this.destroyedWith = err ?? null;
    return this;
  }
}

const originalCreateConnection = net.createConnection;
const sockets = [];

function installFakeSockets() {
  sockets.length = 0;
  net.createConnection = () => {
    const sock = new FakeSocket();
    sockets.push(sock);
    return sock;
  };
}

function restoreSockets() {
  net.createConnection = originalCreateConnection;
}

function observe(promise) {
  const result = { status: 'pending', error: null, promise };
  promise.then(
    () => {
      result.status = 'fulfilled';
    },
    (err) => {
      result.status = 'rejected';
      result.error = err;
    }
  );
  return result;
}

function flushPromises() {
  return sleep(0);
}

/**
 * Await a promise until it settles or the timeout elapses. Returns the observed
 * state so a never-settling promise becomes a failed check instead of a hang.
 */
async function settleWithin(promise, ms = SETTLE_TIMEOUT_MS) {
  const state = observe(promise);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimer(resolve, ms);
  });
  try {
    await Promise.race([new Promise((resolve) => promise.then(resolve, resolve)), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return state;
}

async function connectedPair() {
  const df = new DfConnection();
  const ready = df.connect();
  const sock = sockets.at(-1);
  sock.emit('connect');
  sock.emit('data', COMPLETE_RESPONSE_MAGIC);
  await settleWithin(ready);
  return { df, sock };
}

async function main() {
  // Set before any await: an early exit can never look green.
  process.exitCode = 1;

  installFakeSockets();
  let failures = 0;
  const unhandled = [];
  process.on('unhandledRejection', (err) => {
    unhandled.push(err);
  });
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    if (!ok) failures++;
  };

  const watchdog = setTimer(() => {
    console.log(`FAIL  the lifecycle suite did not finish within ${HARNESS_TIMEOUT_MS}ms`);
    console.log('\nlifecycle harness timed out; failing closed.');
    process.exit(1);
  }, HARNESS_TIMEOUT_MS);

  try {
    {
      const { df, sock } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      const queued = observe(df.call(8, Uint8Array.of(2)));
      check('handshake starts connected', df.connected, df.connected);

      df.close();
      await flushPromises();

      check('close() rejects the in-flight call', active.status === 'rejected', active.status);
      check('close() rejects the queued call', queued.status === 'rejected', queued.status);
      check('close() resets connected', !df.connected, df.connected);
      check('close() ends the socket without destroying it', sock.ended && !sock.destroyedWith, {
        ended: sock.ended,
        destroyed: Boolean(sock.destroyedWith),
      });

      const reconnecting = df.connect();
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(reconnecting);
      check('connect() after close() can reuse the instance', df.connected, df.connected);
    }

    {
      const { df, sock } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      sock.emit('error', new Error('socket died'));
      await flushPromises();

      check('socket error rejects the in-flight call', active.status === 'rejected', active.status);
      check('socket error resets connected', !df.connected, df.connected);
    }

    {
      const { df, sock: dead } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      let reconnect;
      const recovered = active.promise.catch(() => {
        reconnect = df.connect();
        return reconnect;
      });

      dead.emit('error', new Error('socket died'));
      await flushPromises();

      const replacement = sockets.at(-1);
      check(
        'caller observes the rejection before reconnecting',
        Boolean(reconnect),
        Boolean(reconnect)
      );
      check('a reconnect creates a new socket', replacement !== dead, sockets.length);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(recovered);
      check('reconnect succeeds immediately after a failure', df.connected, df.connected);

      dead.emit('close');
      dead.emit('error', new Error('late dead-socket error'));
      await flushPromises();

      check('the dead socket does not take the new one down', df.connected, df.connected);
      check(
        'old socket events leave the replacement alive',
        !replacement.destroyedWith && !replacement.ended,
        { destroyed: Boolean(replacement.destroyedWith), ended: replacement.ended }
      );
      check('reconnect wrote the handshake', replacement.writes.at(0)?.equals(REQUEST_MAGIC), {
        writes: replacement.writes.length,
      });
    }

    {
      const { df, sock: dying } = await connectedPair();
      dying.emit('error', new Error('socket died'));
      await flushPromises();
      check('socket error resets connected before reconnecting', !df.connected, df.connected);

      const reconnecting = df.connect();
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(reconnecting);
      check('reconnect succeeds after an error', df.connected, df.connected);
    }

    {
      const { df, sock } = await connectedPair();
      const active = observe(df.call(7, Uint8Array.of(1)));
      const queued = observe(df.call(8, Uint8Array.of(2)));

      df.close();
      df.close();
      sock.emit('close');
      sock.emit('error', new Error('late close error'));
      await flushPromises();

      check(
        'repeated close() is safe',
        active.status === 'rejected' && queued.status === 'rejected',
        {
          active: active.status,
          queued: queued.status,
        }
      );
      check('events after intentional close are safe', !df.connected, df.connected);

      const reconnecting = df.connect();
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await settleWithin(reconnecting);
      check('late events after close() do not break reuse', df.connected, df.connected);
    }

    // Guard sanity: a promise that never settles must be observed as pending
    // instead of suspending the suite (this is what makes the harness fail
    // closed on a real regression).
    {
      const never = await settleWithin(new Promise(() => {}), 10);
      check('the settle guard reports a stuck promise as pending', never.status === 'pending', {
        status: never.status,
      });
    }

    // Remote close before the handshake reply: connect() must reject promptly
    // with the causal error, and a later stale error must not touch the next
    // attempt.
    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const dead = sockets.at(-1);
      dead.emit('connect');
      dead.emit('close');
      await flushPromises();

      check(
        'remote close before handshake rejects connect()',
        first.status === 'rejected',
        first.status
      );
      check(
        'remote close before handshake reports the causal error',
        first.error instanceof Error && /closed/.test(first.error.message),
        first.error?.message ?? null
      );
      check('remote close before handshake leaves the client disconnected', !df.connected, true);

      const second = observe(df.connect());
      const replacement = sockets.at(-1);
      check(
        'connect() after a pre-handshake close creates a new socket',
        replacement !== dead && second.status === 'pending',
        { newSocket: replacement !== dead, status: second.status }
      );

      dead.emit('close');
      dead.emit('error', new Error('stale dead-socket error'));
      await flushPromises();
      check(
        'a stale error after the pre-handshake close cannot settle the new connect()',
        second.status === 'pending',
        second.error?.message ?? second.status
      );
      check(
        'the aborted connect() keeps its causal error, not the stale one',
        first.status === 'rejected' && !/stale/.test(first.error?.message ?? ''),
        { status: first.status, message: first.error?.message ?? null }
      );

      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await flushPromises();
      check(
        'the replacement handshake still completes after stale events',
        second.status === 'fulfilled' && df.connected,
        { status: second.status, connected: df.connected }
      );
      check(
        'the probe socket survives old-socket events',
        !replacement.destroyedWith && !replacement.ended,
        { destroyed: Boolean(replacement.destroyedWith), ended: replacement.ended }
      );
    }

    // Same pre-handshake abort, but the stale error arrives before the caller
    // reconnects: the original promise keeps the causal error either way.
    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const dead = sockets.at(-1);
      dead.emit('connect');
      dead.emit('close');
      await flushPromises();
      dead.emit('error', new Error('stale error after clean close'));
      await flushPromises();
      check(
        'a stale error cannot re-settle an already rejected connect()',
        first.status === 'rejected' && !/stale/.test(first.error?.message ?? ''),
        { status: first.status, message: first.error?.message ?? null }
      );
      check(
        'the aborted connect() error stays the clean-close error',
        first.error?.message === 'connection closed',
        first.error?.message ?? null
      );
    }

    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const dead = sockets.at(-1);
      dead.emit('connect');
      dead.emit('error', new Error('socket reset before handshake'));
      await flushPromises();

      check(
        'socket error before handshake rejects connect() with that error',
        first.status === 'rejected' && first.error?.message === 'socket reset before handshake',
        { status: first.status, message: first.error?.message ?? null }
      );
      check(
        'a pre-handshake socket error leaves the client disconnected',
        !df.connected,
        df.connected
      );
      check(
        'a pre-handshake socket error destroys the socket with the cause',
        dead.destroyedWith?.message === 'socket reset before handshake',
        dead.destroyedWith?.message ?? null
      );
    }

    // Explicit close() while the handshake is outstanding.
    {
      const df = new DfConnection();
      const first = observe(df.connect());
      const sock = sockets.at(-1);
      sock.emit('connect');
      df.close();
      df.close();
      await flushPromises();

      check(
        'close() before handshake rejects connect()',
        first.status === 'rejected',
        first.status
      );
      check(
        'close() before handshake reports the causal error',
        first.error instanceof Error && /closed/.test(first.error.message),
        first.error?.message ?? null
      );
      check(
        'close() before handshake ends the socket without destroying it',
        sock.ended && !sock.destroyedWith,
        { ended: sock.ended, destroyed: Boolean(sock.destroyedWith) }
      );

      sock.emit('close');
      sock.emit('error', new Error('late error after explicit close'));
      await flushPromises();

      const second = observe(df.connect());
      const replacement = sockets.at(-1);
      replacement.emit('connect');
      replacement.emit('data', COMPLETE_RESPONSE_MAGIC);
      await flushPromises();
      check(
        'the instance is reusable after a pre-handshake close()',
        second.status === 'fulfilled' && df.connected,
        { status: second.status, connected: df.connected }
      );
      check(
        'duplicate pre-handshake events cannot settle the reused connect()',
        second.status === 'fulfilled' && replacement.writes.length === 1,
        { status: second.status, writes: replacement.writes.length }
      );
    }

    // A successful handshake must clear the stored settlement callback, so a
    // later close reports no spurious rejection of the settled promise.
    {
      const { df, sock } = await connectedPair();
      const ready = observe(df.connect());
      await flushPromises();
      check(
        'connect() on a live connection resolves without a new socket',
        ready.status === 'fulfilled' && sockets.at(-1) === sock,
        { status: ready.status, sameSocket: sockets.at(-1) === sock }
      );
    }

    // Public API: DwarfClient.connect() inherits the settlement, so the hang was
    // visible to library consumers too.
    {
      const df = new DwarfClient({ port: 5000 });
      const first = observe(df.connect());
      const sock = sockets.at(-1);
      sock.emit('connect');
      sock.emit('close');
      await flushPromises();
      check(
        'DwarfClient.connect() rejects when the remote closes before handshake',
        first.status === 'rejected',
        first.status
      );
      check(
        'DwarfClient.connect() reports the same causal error',
        first.error instanceof Error && /closed/.test(first.error.message),
        first.error?.message ?? null
      );
    }
  } catch (err) {
    check(`no unexpected exception (${err.message})`, false, err.stack);
  } finally {
    clearTimeout(watchdog);
    restoreSockets();
  }

  check('no unhandled promise rejections', unhandled.length === 0, unhandled.map(String));
  console.log(failures === 0 ? '\nAll lifecycle checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.log(`FAIL  the lifecycle suite crashed (${err?.stack ?? err})`);
  process.exit(1);
});
