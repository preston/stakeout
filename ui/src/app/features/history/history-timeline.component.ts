import { Component, computed, input, output, inject, ElementRef, DestroyRef, signal } from '@angular/core';
import type { TimelineState, HistoryBucket } from '../../core/models/history.model';
const PRIORITY: TimelineState[] = ['down', 'degraded', 'unknown', 'paused', 'up', 'not_retained', 'not_monitored'];
export function bucketState(bucket: HistoryBucket): TimelineState {
  return PRIORITY.find(state => bucket.states.includes(state)) ?? bucket.state;
}
@Component({
  selector: 'app-history-timeline', standalone: true,
  template: `<div class="availability-strip" role="group" [attr.aria-label]="label()">
    @for (bucket of displayed(); track bucket.from) {
      <button type="button" [class]="'period state-' + bucketState(bucket)" [title]="describe(bucket)"
        [attr.aria-label]="describe(bucket)" (click)="periodSelected.emit(bucket)"></button>
    } @empty { <span class="empty">No recorded history</span> }
  </div>`,
  styles: `:host{display:block;min-width:0}.availability-strip{display:flex;gap:1px;min-height:24px;width:100%;min-width:0}.period{flex:1;min-width:0;border:0;border-radius:2px;padding:0;opacity:.88}.period:hover,.period:focus-visible{opacity:1;outline:2px solid var(--bs-body-color);outline-offset:2px;z-index:1}.state-up{background:#258354}.state-degraded{background:#c58b06}.state-down{background:#ce3f4f}.state-unknown{background:#85909f}.state-paused{background:repeating-linear-gradient(45deg,#748093,#748093 3px,#b7bfca 3px,#b7bfca 6px)}.state-not_retained,.state-not_monitored{background:var(--bs-secondary-bg);border:1px dotted var(--bs-secondary-color)}@media(max-width:680px){.availability-strip{gap:0}}.empty{font-size:.8rem;color:var(--bs-secondary-color)}`,
})
export class HistoryTimelineComponent {
  readonly buckets = input<HistoryBucket[]>([]);
  readonly compact = input(false);
  readonly label = input('Availability over the selected period. Select a period for details.');
  readonly periodSelected = output<HistoryBucket>();
  readonly bucketState = bucketState;
  private readonly capacity = signal(240);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (width > 0) this.capacity.set(Math.max(1, Math.min(240, Math.floor(width / 4))));
      });
      observer.observe(host.nativeElement);
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    }
  }
  readonly displayed = computed(() => {
    const buckets = this.buckets();
    const limit = Math.min(this.compact() ? 24 : 240, this.capacity());
    if (buckets.length <= limit) return buckets;
    const result: HistoryBucket[] = [];
    const size = Math.ceil(buckets.length / limit);
    for (let index = 0; index < buckets.length; index += size) {
      const group = buckets.slice(index, index + size);
      const states = [...new Set(group.flatMap(bucket => bucket.states))];
      const bucket: HistoryBucket = { from: group[0].from, to: group[group.length - 1].to, state: group[0].state, states };
      bucket.state = bucketState(bucket);
      result.push(bucket);
    }
    return result;
  });
  describe(bucket: HistoryBucket): string {
    return `${new Date(bucket.from).toLocaleString()} – ${new Date(bucket.to).toLocaleString()}: ${bucket.states.join(', ') || bucket.state}. Select for exact observations.`;
  }
}
