import { createHash } from 'node:crypto';

// Choose only at new-request admission. Saved requests and existing branches
// retain their identity, including lanes created before item-aware naming.
export function dispatchLaneName(topic, item, { existing = false } = {}) {
  if (existing) return topic;
  const id = item.toLowerCase();
  if (`-${topic}-`.includes(`-${id}-`)) return topic;
  const suffix = `-${id}`;
  if (topic.length + suffix.length <= 61) return topic + suffix;
  const digest = createHash('sha256').update(topic).digest('hex').slice(0, 8);
  const room = 61 - suffix.length - digest.length - 1;
  if (room < 1) throw Error('item ID is too long for a lane name');
  return `${topic.slice(0, room).replace(/-+$/, '')}-${digest}${suffix}`;
}

export const dispatchTabLabel = (topic, item) => item ? `agent:${topic} [${item}]` : `agent:${topic}`;
