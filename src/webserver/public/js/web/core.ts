import '../core/socket';
import '../core/preventzoomcontrols';
import './notification';
import '../core/packets';
import '../core/gamepad';
import '../core/virtualcontroller';
import '../core/mobileui';
import '../core/minimap';

// Register Service Worker for sprite/asset caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.warn('[Service Worker] Registration failed:', error);
    });
  });
}