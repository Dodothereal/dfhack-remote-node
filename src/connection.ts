// Node net.Socket transport for DFHack Remote RPC.
//
// Replaces the original browser WebSocket + websockify proxy: DFHack speaks raw
// TCP on localhost:5000, so in Node we talk to it directly. The wire framing is
// unchanged (see codec.ts).
//
// DFHack processes one call at a time on the socket, so calls are serialized
// through a queue. Each call resolves with { result, text } where `result` is
// the RESULT frame body (Buffer) and `text` is the concatenated console output
// from any interleaved TEXT frames — the piece the original client discarded.

import net from 'node:net';
import { REQUEST_MAGIC, RPC_REPLY, encodeMessage, readHandshake, readFrame } from './codec.ts';
import type { Frame } from './codec.ts';
import { ProtocolError, RpcError } from './errors.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5000;

/** Turns a TEXT frame body into a string. */
export type TextDecoder = (body: Buffer) => string;

export interface DfConnectionOptions {
  host?: string;
  port?: number;
  textDecoder?: TextDecoder;
}

/** Result of one RPC call: the RESULT body plus captured console output. */
export interface CallResult {
  result: Buffer;
  text: string;
}

interface PendingCall {
  id: number;
  body: Uint8Array;
  resolve: (value: CallResult) => void;
  reject: (err: Error) => void;
}

export class DfConnection {
  readonly host: string;
  readonly port: number;

  private readonly decodeText: TextDecoder;
  private sock: net.Socket | null = null;
  private ready: Promise<void> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private shookHands = false;
  private queue: PendingCall[] = [];
  private active: PendingCall | null = null;
  private textFrames: Buffer[] = [];

  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, textDecoder }: DfConnectionOptions = {}) {
    this.host = host;
    this.port = port;
    // Default: raw utf-8 of the frame body. The client swaps in a
    // CoreTextNotification decoder.
    this.decodeText = textDecoder ?? ((body) => body.toString('utf8'));
  }

  /** True once connected and past the handshake. */
  get connected(): boolean {
    return this.shookHands;
  }

  /** Connect and complete the handshake. Resolves once ready for calls. */
  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.sock = sock;
      const current = () => this.sock === sock;
      sock.on('connect', () => sock.write(REQUEST_MAGIC));
      sock.on('data', (chunk: Buffer) => {
        if (!current()) return;
        try {
          this.onData(chunk, resolve);
        } catch (err) {
          this.fail(err as Error);
          reject(err as Error);
        }
      });
      sock.on('error', (err) => {
        if (current()) this.fail(err);
        reject(err);
      });
      sock.on('close', () => {
        if (current()) this.fail(new Error('connection closed'));
      });
    });
    return this.ready;
  }

  private onData(chunk: Buffer, onHandshake: () => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    if (!this.shookHands) {
      const consumed = readHandshake(this.buf);
      if (consumed === 0) return; // need more bytes
      this.buf = this.buf.subarray(consumed);
      this.shookHands = true;
      onHandshake();
      this.pump();
    }

    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const parsed = readFrame(this.buf);
      if (!parsed) break;
      this.buf = this.buf.subarray(parsed.consumed);
      this.handleFrame(parsed.frame);
    }
  }

  private handleFrame(frame: Frame): void {
    if (frame.id === RPC_REPLY.TEXT) {
      if (frame.body) this.textFrames.push(frame.body);
      return;
    }

    const call = this.active;
    this.active = null;
    const text = this.textFrames.map((b) => this.decodeText(b)).join('');
    this.textFrames = [];

    if (!call) {
      // A reply with no waiting call: protocol desync — surface loudly.
      this.fail(new ProtocolError('reply frame with no pending call'));
      return;
    }

    if (frame.id === RPC_REPLY.FAIL) {
      const detail = text.trim();
      call.reject(
        new RpcError(
          `RPC call failed (${frame.size})${detail ? `: ${detail}` : ''}`,
          frame.size,
          text
        )
      );
    } else if (frame.id === RPC_REPLY.RESULT) {
      call.resolve({ result: frame.body ?? Buffer.alloc(0), text });
    } else {
      call.reject(new ProtocolError(`unexpected frame id ${frame.id}`));
    }
    this.pump();
  }

  /** Send the next queued call if the socket is idle. */
  private pump(): void {
    if (!this.shookHands || this.active || this.queue.length === 0 || !this.sock) return;
    const call = this.queue.shift()!;
    this.active = call;
    this.textFrames = [];
    this.sock.write(encodeMessage(call.id, call.body));
  }

  /**
   * Send one RPC call. `id` is the bound method id (0 for BindMethod).
   * Returns { result: Buffer, text: string }.
   */
  call(id: number, body: Uint8Array): Promise<CallResult> {
    return new Promise<CallResult>((resolve, reject) => {
      this.queue.push({ id, body, resolve, reject });
      this.pump();
    });
  }

  private teardown(err: Error, destroy: boolean): void {
    const sock = this.sock;
    this.sock = null;
    this.shookHands = false;
    this.ready = null;
    this.buf = Buffer.alloc(0);
    this.textFrames = [];

    if (sock) {
      if (destroy) sock.destroy(err);
      else sock.end();
    }

    const pending = this.active ? [this.active, ...this.queue] : [...this.queue];
    this.active = null;
    this.queue = [];
    for (const call of pending) call.reject(err);
  }

  private fail(err: Error): void {
    this.teardown(err, true);
  }

  close(): void {
    this.teardown(new Error('connection closed'), false);
  }
}
