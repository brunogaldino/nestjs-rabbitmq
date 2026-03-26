export function tryParseJson(content: string) {
  try {
    return !!content && JSON.parse(content);
  } catch (e) {
    return content;
  }
}

// export function merge<T extends Record<string, any>>(source: Partial<T>, target: Partial<T>): T {
//   const merged = { ...source };
//
//   for (const key in target) {
//     if (target[key] == null) continue;
//
//     if (key in merged && typeof target[key] === "object" && !Array.isArray(target[key])) {
//       merged[key] = merge(source[key] as any, target[key] as any);
//     } else {
//       merged[key] = target[key] ?? source[key];
//     }
//   }
//
//   return merged as T;
// }

export function merge(source, target) {
  const merged = { ...source };

  for (const key in target) {
    if (target[key] == null) continue;

    if (key in merged) {
      if (typeof target[key] === "object")
        merged[key] = merge(source[key], target[key]);
      else {
        merged[key] = target[key] ?? source[key];
      }
    } else {
      merged[key] = target[key];
    }
  }

  return merged;
}
