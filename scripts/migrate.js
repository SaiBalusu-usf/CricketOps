import * as store from '../server/store.js';

try {
  await store.ensureDirs();
  console.log('Postgres schema is ready.');
} finally {
  await store.close();
}
