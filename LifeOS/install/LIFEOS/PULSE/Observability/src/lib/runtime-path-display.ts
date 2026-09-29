export interface RuntimePathDisplay {
  configRoot: string;
  lifeosDir: string;
  userDir: string;
  memoryDir: string;
  pulseDir: string;
  toolsDir: string;
  skillsDir: string;
  envPath: string;
  settingsPath: string;
}

export type RuntimePathKey = keyof RuntimePathDisplay;

export function appendRuntimePath(base: string, ...segments: string[]): string {
  const separator = base.includes("\\") ? "\\" : "/";
  const trimSeparators = (value: string) => value.replace(/^[/\\]+|[/\\]+$/g, "");
  const normalized = [base, ...segments]
    .filter(Boolean)
    .map((part) => trimSeparators(part).replace(/[\\/]+/g, separator));
  return normalized.join(separator);
}

export function getRuntimePathText(
  paths: RuntimePathDisplay | null,
  root: RuntimePathKey,
  segments: string[] = [],
  fallback = "LifeOS runtime path",
): string {
  const base = paths?.[root];
  return base ? appendRuntimePath(base, ...segments) : appendRuntimePath(fallback, ...segments);
}
