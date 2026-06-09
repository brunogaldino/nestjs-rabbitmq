import { randomInt } from "crypto";

export function tryParseJson(content: string) {
  try {
    return !!content && JSON.parse(content);
  } catch (e) {
    return content;
  }
}

export function merge<T = Record<string, any>>(source: Record<string, any>, target: Record<string, any>): T {
  const merged = { ...source };

  for (const key in target) {
    if (target[key] == null) continue;

    if (key in merged && typeof target[key] === "object" && !Array.isArray(target[key])) {
      merged[key] = merge(source[key], target[key]);
    } else {
      merged[key] = target[key] ?? source[key];
    }
  }

  return merged as T;
}

export function generateRandomChars(length = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[randomInt(0, chars.length)]).join('');
}
