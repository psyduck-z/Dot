// Polyfills must land before anything else touches a missing API.
import './compat.ts';

import { App } from './app.ts';

const root = document.getElementById('app');

if (!root) {
  throw new Error('missing #app root');
}

const app = new App(root);
void app.start();
