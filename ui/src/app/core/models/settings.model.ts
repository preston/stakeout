export enum ThemeType {
  AUTOMATIC = 'automatic',
  LIGHT = 'light',
  DARK = 'dark',
}

export class Settings {
  static readonly DEFAULT_THEME = ThemeType.AUTOMATIC;

  experimental = false;
  developer = false;
  cds_username = '';
  cds_password = '';
  theme_preferred: ThemeType = ThemeType.AUTOMATIC;
}
