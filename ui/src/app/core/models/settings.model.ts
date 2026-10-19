// Author: Preston Lee

import { DEFAULT_PREFERENCES, type UserPreferences } from '@stakeout/core';

export enum ThemeType { AUTOMATIC = 'automatic', LIGHT = 'light', DARK = 'dark' }
export class Settings implements UserPreferences {
  experimental = DEFAULT_PREFERENCES.experimental;
  developer = DEFAULT_PREFERENCES.developer;
  themePreferred = DEFAULT_PREFERENCES.themePreferred;
  screenshots = DEFAULT_PREFERENCES.screenshots;
  displayMode = DEFAULT_PREFERENCES.displayMode;
  refreshIntervalMs = DEFAULT_PREFERENCES.refreshIntervalMs;
  dashboardOrder = DEFAULT_PREFERENCES.dashboardOrder;
  serviceSort = DEFAULT_PREFERENCES.serviceSort;
  serviceOrder = DEFAULT_PREFERENCES.serviceOrder;
}
