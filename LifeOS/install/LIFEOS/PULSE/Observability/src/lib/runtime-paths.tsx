"use client";

import { useEffect, useState } from "react";
import { getRuntimePathText, type RuntimePathDisplay, type RuntimePathKey } from "./runtime-path-display";
export { appendRuntimePath, getRuntimePathText } from "./runtime-path-display";
export type { RuntimePathDisplay, RuntimePathKey } from "./runtime-path-display";

let cachedPaths: RuntimePathDisplay | null = null;
let pendingPaths: Promise<RuntimePathDisplay | null> | null = null;

function loadRuntimePaths(): Promise<RuntimePathDisplay | null> {
  if (cachedPaths) return Promise.resolve(cachedPaths);
  if (!pendingPaths) {
    pendingPaths = fetch("/api/runtime/paths")
      .then((response) => (response.ok ? response.json() as Promise<RuntimePathDisplay> : null))
      .then((paths) => {
        cachedPaths = paths;
        return paths;
      })
      .catch(() => null);
  }
  return pendingPaths;
}

export function useRuntimePaths(): RuntimePathDisplay | null {
  const [paths, setPaths] = useState<RuntimePathDisplay | null>(cachedPaths);

  useEffect(() => {
    let active = true;
    void loadRuntimePaths().then((loaded) => {
      if (active) setPaths(loaded);
    });
    return () => { active = false; };
  }, []);

  return paths;
}

export default function RuntimePath({
  root,
  segments = [],
  fallback,
}: {
  root: RuntimePathKey;
  segments?: string[];
  fallback: string;
}) {
  const paths = useRuntimePaths();
  return <>{getRuntimePathText(paths, root, segments, fallback)}</>;
}
