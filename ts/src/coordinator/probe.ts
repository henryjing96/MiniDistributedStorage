// Background health probe for storage nodes. Mirrors go/internal/coordinator/probe.

export interface ProbeOptions {
  nodes: string[];
  intervalMs: number;
  timeoutMs: number;
  onChange?: (node: string, up: boolean) => void;
}

export class NodeProbe {
  private up = new Map<string, boolean>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private opts: ProbeOptions) {
    // optimistic start so we don't reject all writes during the first tick
    for (const n of opts.nodes) this.up.set(n, true);
  }

  start(): void {
    if (this.opts.intervalMs <= 0) return;
    void this.probeAll();
    this.timer = setInterval(() => void this.probeAll(), this.opts.intervalMs);
    // unref so this doesn't keep the event loop alive in tests
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isUp(node: string): boolean {
    return this.up.get(node) ?? false;
  }

  private async probeAll(): Promise<void> {
    await Promise.all(this.opts.nodes.map((n) => this.probeOne(n)));
  }

  private async probeOne(node: string): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let up = false;
    try {
      const r = await fetch(node + "/healthz", { signal: ctrl.signal });
      up = r.status === 200;
      // drain
      await r.arrayBuffer().catch(() => undefined);
    } catch {
      up = false;
    } finally {
      clearTimeout(t);
    }
    const prev = this.up.get(node);
    this.up.set(node, up);
    if (prev !== up) this.opts.onChange?.(node, up);
  }
}
