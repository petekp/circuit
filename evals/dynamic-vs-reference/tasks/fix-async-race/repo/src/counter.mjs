// A counter whose bump() reads the current value, yields to the event loop,
// then writes value + 1. The read and write straddle an await, so two
// concurrent bumps both read the same value and one increment is lost.
export class Counter {
  constructor() {
    this.value = 0;
  }

  async bump() {
    const current = this.value;
    await Promise.resolve();
    this.value = current + 1;
  }
}
