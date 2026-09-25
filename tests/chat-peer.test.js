import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrivatePeer } from '../chat-peer.js';

const inputPeer = (userId = 2n) => ({ className: 'InputPeerUser', userId, accessHash: 987654321n });
const shortEvent = (userId = 2n, extra = {}) => ({
  message: { peerId: { className: 'PeerUser', userId } }, ...extra,
});

test('cold short-message updates use the event input chat without re-resolving a bare peer', async () => {
  const resolved = inputPeer();
  let hydrationCalls = 0;
  const event = shortEvent(2n, { async getInputChat() { hydrationCalls++; return resolved; } });
  const client = {
    getInputEntity() { assert.fail('event supplied the usable peer'); },
    iterDialogs() { assert.fail('event supplied the usable peer'); },
  };
  assert.equal(await resolvePrivatePeer(client, event, '1'), resolved);
  assert.equal(hydrationCalls, 1);
  assert.notEqual(resolved, event.message.peerId);
});

test('entity cache resolves an unavailable or mismatched event input chat', async () => {
  for (const getInputChat of [
    undefined,
    async () => { throw new Error('cache cold'); },
    async () => inputPeer(3n),
  ]) {
    const event = shortEvent(2n, { getInputChat });
    const resolved = inputPeer();
    const client = {
      async getInputEntity(peer) { assert.equal(peer, event.message.peerId); return resolved; },
      iterDialogs() { assert.fail('cache resolution should avoid fetching dialogs'); },
    };
    assert.equal(await resolvePrivatePeer(client, event, '1'), resolved);
  }
});

test('dialog fallback requires both the exact dialog ID and matching input peer', async () => {
  const resolved = inputPeer(9007199254740995n);
  const event = shortEvent(resolved.userId, { async getInputChat() { throw new Error('cold event'); } });
  let dialogsCalls = 0;
  let consumed = 0;
  const client = {
    async getInputEntity() { throw new Error('cold cache'); },
    async *iterDialogs(options) {
      dialogsCalls++;
      assert.deepEqual(options, {});
      for (const dialog of [
        { id: 3n, inputEntity: resolved },
        { id: resolved.userId, inputEntity: inputPeer(3n) },
        { id: resolved.userId, inputEntity: resolved },
        { id: resolved.userId, inputEntity: inputPeer(4n) },
      ]) { consumed++; yield dialog; }
    },
  };
  assert.equal(await resolvePrivatePeer(client, event, '1'), resolved);
  assert.equal(dialogsCalls, 1);
  assert.equal(consumed, 3, 'do not continue fetching dialogs after a verified match');
});

test('mismatched resolver results never redirect output into another private chat', async () => {
  const event = shortEvent(2n, { async getInputChat() { return inputPeer(3n); } });
  const client = {
    async getInputEntity() { return inputPeer(4n); },
    async *iterDialogs() {
      yield { id: 2n, inputEntity: inputPeer(5n) };
      yield { id: 6n, inputEntity: inputPeer(2n) };
    },
  };
  await assert.rejects(resolvePrivatePeer(client, event, '1'), { code: 'CHAT_RESOLUTION_FAILED' });
});

test('self peer is accepted only for the authenticated owner, never an ordinary DM', async () => {
  const self = { className: 'InputPeerSelf' };
  const selfEvent = shortEvent(1n, { async getInputChat() { return self; } });
  assert.equal(await resolvePrivatePeer({}, selfEvent, '1'), self);

  const otherEvent = shortEvent(2n, { async getInputChat() { return self; } });
  const resolved = inputPeer();
  assert.equal(await resolvePrivatePeer({ async getInputEntity() { return resolved; } }, otherEvent, '1'), resolved);
  await assert.rejects(resolvePrivatePeer({
    async getInputEntity() { return self; },
    async *iterDialogs() { yield { id: 2n, inputEntity: self }; },
  }, otherEvent, '1'), { code: 'CHAT_RESOLUTION_FAILED' });
});

test('resolution failures expose only a safe error and not underlying Telegram details', async () => {
  const event = shortEvent(2n, { async getInputChat() { throw new Error('private event detail'); } });
  for (const client of [
    { async getInputEntity() { throw new Error('private cache detail'); } },
    {
      async getInputEntity() { throw new Error('private cache detail'); },
      async *iterDialogs() { throw new Error('private dialog detail'); },
    },
  ]) {
    await assert.rejects(resolvePrivatePeer(client, event, '1'), error => {
      assert.equal(error.code, 'CHAT_RESOLUTION_FAILED');
      assert.equal(error.message, 'Cannot resolve command chat');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
