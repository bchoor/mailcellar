// The one Node API the Worker uses (compatibility flag nodejs_als), typed here rather than pulling in @types/node.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
