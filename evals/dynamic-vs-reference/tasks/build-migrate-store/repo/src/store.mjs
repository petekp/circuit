// In-memory key/value store using Node-style callbacks. Migrate the whole
// module to async/await: get(key) and set(key, value) should return promises.
export function createStore() {
  const data = new Map();
  return {
    get(key, cb) {
      queueMicrotask(() => cb(null, data.get(key)));
    },
    set(key, value, cb) {
      queueMicrotask(() => {
        data.set(key, value);
        cb(null, value);
      });
    },
  };
}
