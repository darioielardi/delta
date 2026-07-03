import "@testing-library/jest-dom";

// Node 26 exposes browser storage only when launched with --localstorage-file.
// Tests run in happy-dom, so provide the usual browser-like in-memory storage
// instead of requiring every developer/CI command to pass NODE_OPTIONS.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

if (!localStorageDescriptor || "get" in localStorageDescriptor) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}
