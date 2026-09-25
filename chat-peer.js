/** Resolve short updates from another device without guessing an access hash. */
export async function resolvePrivatePeer(client, event, ownerId) {
  const expected = String(event.message.peerId.userId);
  const matches = peer => peer && (peer.userId != null
    ? String(peer.userId) === expected
    : peer.className === 'InputPeerSelf' && expected === String(ownerId));
  // GramJS getInputChat hydrates the dialog cache for UpdateShortMessage events.
  // A bare PeerUser only contains an ID and may not be sendable after restart.
  let peer;
  try { peer = await event.getInputChat?.(); } catch { /* Try other public resolvers. */ }
  if (matches(peer)) return peer;
  try { peer = await client.getInputEntity(event.message.peerId); } catch { /* Cold cache. */ }
  if (matches(peer)) return peer;
  if (typeof client.iterDialogs === 'function') {
    try {
      for await (const dialog of client.iterDialogs({})) {
        if (String(dialog.id) === expected && matches(dialog.inputEntity)) return dialog.inputEntity;
      }
    } catch { /* Never expose raw Telegram errors or peer identifiers. */ }
  }
  throw Object.assign(new Error('Cannot resolve command chat'), { code: 'CHAT_RESOLUTION_FAILED' });
}
