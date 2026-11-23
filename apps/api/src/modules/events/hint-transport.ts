import { Injectable } from '@nestjs/common';
import type { EventHint } from '@collabboard/contracts';

export interface HintTransport {
  publish(recipientId: string, hint: EventHint): Promise<void>;
}
export const HINT_TRANSPORT = Symbol('HintTransport');

@Injectable()
export class LocalHintTransport implements HintTransport {
  private readonly listeners = new Map<
    string,
    Set<(hint: EventHint) => void>
  >();

  subscribe(userId: string, listener: (hint: EventHint) => void) {
    const listeners = this.listeners.get(userId) ?? new Set();
    if (listeners.size >= 10) throw new Error('Too many event connections.');
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(userId);
    };
  }

  async publish(recipientId: string, hint: EventHint) {
    for (const listener of this.listeners.get(recipientId) ?? [])
      listener(hint);
  }
}
