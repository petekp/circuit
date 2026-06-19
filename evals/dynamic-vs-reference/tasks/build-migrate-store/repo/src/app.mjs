// Records a visit for a user and reports the new count. Must keep working
// after the store migrates to async/await.
export function recordVisit(store, user, cb) {
  store.get(user, (err, current) => {
    if (err) return cb(err);
    store.set(user, (current ?? 0) + 1, (err2, next) => {
      if (err2) return cb(err2);
      cb(null, next);
    });
  });
}
