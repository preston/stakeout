// Author: Preston Lee

export interface UserPreferences {
  experimental: boolean;
  developer: boolean;
  themePreferred: 'automatic' | 'light' | 'dark';
  screenshots: boolean;
  displayMode: 'overlay' | 'wide';
  refreshIntervalMs: number;
  dashboardOrder: 'asc' | 'desc';
  serviceSort: 'name' | 'updatedAt';
  serviceOrder: 'asc' | 'desc';
}

export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = {
  experimental: false, developer: false, themePreferred: 'automatic',
  screenshots: true, displayMode: 'overlay', refreshIntervalMs: 60000,
  dashboardOrder: 'asc', serviceSort: 'name', serviceOrder: 'asc',
};

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDto {
  user: UserDto;
  preferences: UserPreferences;
  csrfToken: string;
  expiresAt: string;
}

export interface UserInput {
  username: string;
  displayName: string;
  isActive: boolean;
}

export interface CreateUserInput extends UserInput {
  password: string;
}
