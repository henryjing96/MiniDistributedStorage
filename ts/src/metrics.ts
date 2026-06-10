// Minimal Prometheus text-format metrics registry. Counters + gauges only.
// Mirrors go/internal/metrics.

type LabelPairs = string; // pre-encoded `{k="v",k2="v2"}` or ""

function encodeLabels(labels: ReadonlyArray<string>): LabelPairs {
  if (labels.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < labels.length; i += 2) {
    const k = labels[i] ?? "";
    const v = labels[i + 1] ?? "";
    parts.push(`${k}="${escapeLabel(v)}"`);
  }
  return "{" + parts.join(",") + "}";
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class Counter {
  private series = new Map<LabelPairs, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(...labels: string[]): void {
    this.add(1, ...labels);
  }
  add(delta: number, ...labels: string[]): void {
    const k = encodeLabels(labels);
    this.series.set(k, (this.series.get(k) ?? 0) + delta);
  }
  /** Internal: enumerate series for the registry to serialize. */
  _entries(): Iterable<[LabelPairs, number]> {
    return this.series.entries();
  }
}

export class Gauge {
  private series = new Map<LabelPairs, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(value: number, ...labels: string[]): void {
    this.series.set(encodeLabels(labels), value);
  }
  _entries(): Iterable<[LabelPairs, number]> {
    return this.series.entries();
  }
}

export class Registry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();

  newCounter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  newGauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help);
      this.gauges.set(name, g);
    }
    return g;
  }

  /** Render in Prometheus text exposition format. */
  format(): string {
    const all: string[] = [];
    const names = [
      ...[...this.counters.keys()].map((n) => ({ n, kind: "counter" as const })),
      ...[...this.gauges.keys()].map((n) => ({ n, kind: "gauge" as const })),
    ].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    for (const { n, kind } of names) {
      const m = kind === "counter" ? this.counters.get(n)! : this.gauges.get(n)!;
      all.push(`# HELP ${n} ${m.help}`);
      all.push(`# TYPE ${n} ${kind}`);
      const entries = [...m._entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [labels, value] of entries) {
        all.push(`${n}${labels} ${value}`);
      }
    }
    return all.join("\n") + "\n";
  }
}
