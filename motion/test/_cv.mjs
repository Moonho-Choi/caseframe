import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let cvPromise = null;
export function cvReady() {
  if (!cvPromise) cvPromise = new Promise((resolve) => {
    const cv = require('../../vendor/opencv.js');
    cv.then(() => resolve(new Proxy(cv, {
      get(target, prop, receiver) {
        if (prop === 'then') return undefined;
        return Reflect.get(target, prop, receiver);
      }
    })));
  });
  return cvPromise;
}
