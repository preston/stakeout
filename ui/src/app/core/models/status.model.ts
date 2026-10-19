import type { StatusDto } from '@stakeout/core';

export class Status implements StatusDto {
  message = '';
  server = { datetime: '' };
  database = { datetime: '' };
}
