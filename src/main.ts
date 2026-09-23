// Polyfills must land before anything else touches a missing API.
import './compat.ts';

import { App } from './app.ts';
import { markBootSuccessful } from './updater.ts';
import { startMirror } from './remote.ts';
import { startCrashWatch } from './crash.ts';

// Both before the app, and outside everything that could go wrong in it.
//
// The crash watch has to be first: it exists to notice that the previous
// session never finished, and anything that throws before it runs is the exact
// case it is there to catch.
//
// The mirror used to run after start() resolved, which had it backwards. It is
// how a device with no USB, no browser and no developer options says what it is
// doing, and the moment that matters most is when the app has failed to start;
// anything that threw or never settled took the only means of finding out why
// down with it. It is a no-op unless Dot was served over plain HTTP, which on
// the watch means the dev server and nothing else.
startCrashWatch();
startMirror();

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
