import { TestBed } from '@angular/core/testing';
import { HistoryTimelineComponent, bucketState } from './history-timeline.component';
import type { HistoryBucket } from '../../core/models/history.model';

describe('HistoryTimelineComponent', () => {
  it('keeps brief outages visible when a bucket also contains healthy time', () => {
    expect(bucketState({ from: '', to: '', state: 'up', states: ['up', 'down'] })).toBe('down');
  });
  it('compacts a long strip without losing disruptions and supports keyboard and pointer details', () => {
    const fixture = TestBed.createComponent(HistoryTimelineComponent);
    const buckets: HistoryBucket[] = Array.from({ length: 240 }, (_, index) => ({
      from: new Date(index * 1000).toISOString(), to: new Date((index + 1) * 1000).toISOString(), state: 'up', states: ['up'],
    }));
    buckets[113].states.push('down');
    fixture.componentRef.setInput('buckets', buckets); fixture.componentRef.setInput('compact', true); fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(24);
    expect(fixture.nativeElement.querySelectorAll('.state-down').length).toBe(1);
    expect(buttons[11].getAttribute('aria-label')).toContain('down');
    let selected: HistoryBucket | undefined;
    fixture.componentInstance.periodSelected.subscribe(bucket => selected = bucket);
    buttons[11].click(); expect(selected?.states).toContain('down');
  });
  it('distinguishes time without retained observations', () => {
    const fixture = TestBed.createComponent(HistoryTimelineComponent);
    fixture.componentRef.setInput('buckets', [{ from: '2026-10-01', to: '2026-10-02', state: 'not_retained', states: ['not_retained'] }]);
    fixture.detectChanges(); expect(fixture.nativeElement.querySelector('.state-not_retained')).not.toBeNull();
  });
});
