/**
 * Deduplicação simples em memória por ID de mensagem.
 * Não persiste após reiniciar e não funciona com várias instâncias — em produção, use Redis/banco.
 */
export class Deduplicator {
  private seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
  ) {}

  /** Retorna true na primeira vez que vê o ID; false nas repetições. */
  firstTime(id: string, now = Date.now()): boolean {
    const at = this.seen.get(id);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.set(id, now);
    if (this.seen.size > this.maxEntries) {
      for (const [key, t] of this.seen) {
        if (now - t >= this.ttlMs || this.seen.size > this.maxEntries) this.seen.delete(key);
        else break;
      }
    }
    return true;
  }
}
