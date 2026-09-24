export function createLatestResource() {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    async load(load, commit, dispose = () => {}) {
      const requested = ++revision;
      let value;
      try {
        value = await load();
      } catch (error) {
        if (requested !== revision) return false;
        throw error;
      }
      if (requested !== revision) {
        await dispose(value);
        return false;
      }
      commit(value);
      return true;
    },
  };
}

export function createSerialWriter(write) {
  let tail = Promise.resolve();
  return value => {
    const result = tail.then(() => write(value));
    tail = result.catch(() => {});
    return result;
  };
}
