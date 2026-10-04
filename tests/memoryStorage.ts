import type { DeviceStorage } from "../deviceStorage";

/**
 * A device storage held in memory, for tests. Values go in and out as JSON,
 * as they do in a real one, so a caller can never change what is stored by
 * changing what it read — and a value that would not survive JSON fails here
 * as it would on a device.
 */
export function memoryStorage(): DeviceStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    load: (key) => {
      const value = values.get(key);
      return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
    },
    save: (key, value) => {
      if (value === null || value === undefined) values.delete(key);
      else values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    },
  };
}
