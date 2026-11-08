import { recordFingerprint, storageItemId } from "./canonical";
import { EMBEDDING_KEY, bestChunkMatch } from "./semantic";
import { EMBEDDINGS, derivedKey, derivedOwner, readDerivedKeys } from "./store";
import type { CachedEmbedding } from "./store";
import type { ConversationRecord, Evidence } from "./types";

/**
 * The two messages, one in each conversation, closest in meaning — read
 * from the vectors stored on this device, for "why are these related?".
 * Nothing when either conversation has no current vectors (the feature is
 * off, or the conversation changed since it was embedded).
 */
export async function closestMessages(a: ConversationRecord, b: ConversationRecord): Promise<{ a: Evidence; b: Evidence; score: number } | undefined> {
  const owner = derivedOwner();
  const [ea, eb] = await readDerivedKeys<CachedEmbedding>(EMBEDDINGS, [derivedKey(owner, a.workspaceId, storageItemId(a)), derivedKey(owner, b.workspaceId, storageItemId(b))]);
  const current = (entry: CachedEmbedding | undefined, record: ConversationRecord) => !!entry && entry.model === EMBEDDING_KEY && entry.fingerprint === recordFingerprint(record);
  if (!current(ea, a) || !current(eb, b)) return undefined;
  const best = bestChunkMatch(ea!, eb!);
  if (!best) return undefined;
  const quote = (record: ConversationRecord, index: number): Evidence | undefined => {
    const message = record.messages[index];
    return message ? { recordId: record.id, messageIndex: index, role: message.role, quote: message.text.replace(/\s+/g, " ").trim().slice(0, 200) } : undefined;
  };
  const qa = quote(a, best.a);
  const qb = quote(b, best.b);
  return qa && qb ? { a: qa, b: qb, score: best.score } : undefined;
}
