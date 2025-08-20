export type PackageManager = string; // 如 "pnpm", "npm", "yarn", 或 "pnpm run"

export interface DopingProject {
  name?: string;
  path: string; // relative to workspace root
  packageManager?: PackageManager;     // default: "pnpm"
  autoExpandProjects?: boolean;        // default: true
  includeScripts?: string[];
  excludeScripts?: string[];
}

export interface DopingConfig {
  projects?: DopingProject[];
  cn?: boolean; // 是否使用中文
}

export interface ProjectResolved {
  name: string;
  absPath: string;
  relPath: string;
  packageManager: PackageManager;
  autoExpandProjects: boolean;
  includeScripts?: string[];
  excludeScripts?: string[];
}