// Polyfills must land before anything else touches a missing API.
import './compat.ts';

import { App } from './app.ts';
import { markBootSuccessful } from './updater.ts';

const root = document.getElementById('app');

if (!root) {
  throw new Error('missing #app root');
}

const app = new App(root);
void app.start().then(() => {
  // Clears the boot sentinel. Until this runs, the downloaded build this
  // launched from is considered untrusted and will be discarded next time.
  markBootSuccessful();
});
