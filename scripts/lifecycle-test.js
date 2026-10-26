// Offline connection lifecycle test. Fake sockets let each test control event
// order precisely: an old socket's error, late close, and repeated events can
// be delivered after a replacement socket has connected.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DfConnection } from '../src/connection.ts';
import { HANDSHAKE_LEN, REQUEST_MAGIC, RESPONSE_MAGIC } from '../src/codec.ts';

const COMPLETE_RESPONSE_MAGIC = Buffer.alloc(HANDSHAKE_LEN);
RESPONSE_MAGIC.copy(COMPLETE_RESPONSE_MAGIC);
COMPLETE_RESPONSE_MAGIC.writeInt32LE(1, RESPONSE_MAGIC.length);

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

async function connectedPair() {
  const df = new DfConnection();
  const ready = df.connect();
  const sock = sockets.at(-1);
  sock.emit('connect');
  sock.emit('data', COMPLETE_RESPONSE_MAGIC);
  await ready;
  return { df, sock };
}

async function main() {
  installFakeSockets();
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got: ${JSON.stringify(detail)})`}`);
    if (!ok) failures++;
  };

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
      await reconnecting;
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
      await recovered;
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
      await reconnecting;
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
      await reconnecting;
      check('late events after close() do not break reuse', df.connected, df.connected);
    }
  } catch (err) {
    check(`no unexpected exception (${err.message})`, false, err.stack);
  } finally {
    restoreSockets();
  }

  console.log(failures === 0 ? '\nAll lifecycle checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
