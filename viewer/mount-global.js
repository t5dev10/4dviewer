// Exposes mountViewer on window for pages that load the viewer with a plain
// <script type="module" src="…/viewer/mount-global.js"> tag.
import { mountViewer } from './js/index.js';

window.__tg4dMountViewer = mountViewer;
window.dispatchEvent(new CustomEvent('tg4d:mount-ready'));
