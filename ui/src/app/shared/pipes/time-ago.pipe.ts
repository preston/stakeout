// Author: Preston Lee

import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'timeAgo',
  standalone: true,
})
export class TimeAgoPipe implements PipeTransform {
  private readonly rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  transform(
    value: Date | string | number | null | undefined,
    /** Pass a changing timestamp (e.g. {@link ClockService.now}) to refresh the label over time. */
    _tick?: number
  ): string {
    void _tick;

    if (value == null || value === 0) {
      return '';
    }

    const date = this.toDate(value);
    if (!date) {
      return '';
    }

    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(seconds);

    if (abs < 60) {
      return this.rtf.format(seconds, 'second');
    }
    if (abs < 3600) {
      return this.rtf.format(Math.round(seconds / 60), 'minute');
    }
    if (abs < 86400) {
      return this.rtf.format(Math.round(seconds / 3600), 'hour');
    }
    if (abs < 2592000) {
      return this.rtf.format(Math.round(seconds / 86400), 'day');
    }
    if (abs < 31536000) {
      return this.rtf.format(Math.round(seconds / 2592000), 'month');
    }
    return this.rtf.format(Math.round(seconds / 31536000), 'year');
  }

  private toDate(value: Date | string | number): Date | null {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'number') {
      return new Date(value);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
}
