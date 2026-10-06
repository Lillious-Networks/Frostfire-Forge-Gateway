// Light/dark theme for the account pages (login, registration, realm list,
// password reset, profile, 2FA). The choice is shared with the documentation
// site through the same storage key.
(() => {
  const STORAGE_KEY = 'docs-theme';

  function stored(): 'dark' | 'light' {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  function apply(theme: 'dark' | 'light'): void {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b1120' : '#ffffff');
  }

  function bind(): void {
    document.getElementById('theme-button')?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage can be blocked (private mode); the choice just won't persist.
      }
    });
  }

  apply(stored());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
