export interface ProductivityRouteHooks {
  write: <T>(action: () => T) => Promise<T>;
  onChange: () => void;
}

export function problem(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
