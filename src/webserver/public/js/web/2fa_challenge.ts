declare global {
  interface Window {
    Notify: (type: string, message: string, time?: number) => void;
  }
}

function getToken(): string {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'token') return value;
  }
  return '';
}

function base64UrlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

let availableMethods: string[] = [];
let isWebAuthnPending = false;

async function init() {
  const token = getToken();
  if (!token) {
    window.location.href = '/';
    return;
  }

  try {
    const response = await fetch('/api/2fa/status', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) {
      window.location.href = '/';
      return;
    }
    const body = await response.json();
    availableMethods = body.methods || [body.method];

    if (availableMethods.length === 1) {
      startMethod(availableMethods[0]);
    } else {
      showMethodPicker();
    }
  } catch {
    window.location.href = '/';
  }
}

function showMethodPicker() {
  document.getElementById('challenge-message')!.textContent = 'Select a method to verify your identity';
  document.getElementById('method-picker')!.classList.remove('hidden');

  for (const m of availableMethods) {
    if (m === 'webauthn') document.getElementById('pick-webauthn')!.classList.remove('hidden');
    if (m === 'totp') document.getElementById('pick-totp')!.classList.remove('hidden');
  }

  document.getElementById('pick-webauthn')?.addEventListener('click', () => startMethod('webauthn'));
  document.getElementById('pick-totp')?.addEventListener('click', () => startMethod('totp'));
}

function startMethod(method: string) {
  if (method === 'webauthn') {
    document.getElementById('method-picker')!.classList.add('hidden');
    document.getElementById('challenge-message')!.textContent = 'Insert your security key and tap it to continue';
    startWebAuthn();
    return;
  }

  document.getElementById('method-picker')!.classList.add('hidden');

  document.getElementById('code-section')!.classList.remove('hidden');
  const input = document.getElementById('code-input') as HTMLInputElement;
  input.value = '';
  input.focus();

  document.getElementById('code-label')!.textContent = 'Authenticator Code';
  document.getElementById('challenge-message')!.textContent = 'Enter your authenticator code';
}

async function startWebAuthn() {
  if (isWebAuthnPending) return;
  isWebAuthnPending = true;

  if (!window.isSecureContext || !navigator?.credentials) {
    window.Notify('error', 'WebAuthn requires HTTPS or localhost');
    showMethodPicker();
    isWebAuthnPending = false;
    return;
  }

  try {
    const token = getToken();
    const optionsResponse = await fetch('/api/2fa/auth-webauthn', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!optionsResponse.ok) {
      const err = await optionsResponse.json();
      window.Notify('error', err.message);
      showMethodPicker();
      isWebAuthnPending = false;
      return;
    }

    const options = await optionsResponse.json();

    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: base64UrlToBuffer(options.challenge),
      rpId: options.rpId,
      allowCredentials: options.allowCredentials.map((cred: any) => ({
        type: 'public-key',
        id: base64UrlToBuffer(cred.id),
      })),
      timeout: options.timeout,
      userVerification: options.userVerification,
    };

    const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to get credential');

    const response = credential.response as AuthenticatorAssertionResponse;

    const verifyResponse = await fetch('/api/2fa/verify-webauthn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        credentialId: credential.id,
        clientDataJSON: bufferToBase64Url(response.clientDataJSON),
        authenticatorData: bufferToBase64Url(response.authenticatorData),
        signature: bufferToBase64Url(response.signature),
      }),
    });

    const verifyBody = await verifyResponse.json();
    if (verifyResponse.ok) {
      window.location.href = '/realm-selection';
    } else {
      window.Notify('error', verifyBody.message);
      showMethodPicker();
    }
  } catch (err: any) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      window.Notify('error', err.message || 'WebAuthn authentication failed');
    }
    showMethodPicker();
  } finally {
    isWebAuthnPending = false;
  }
}

document.getElementById('code-submit-btn')?.addEventListener('click', async () => {
  const code = (document.getElementById('code-input') as HTMLInputElement).value.trim();
  if (!code || code.length !== 6) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/2fa/verify-totp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ code }),
  });

  const body = await response.json();
  if (response.ok) {
    window.location.href = '/realm-selection';
  } else {
    window.Notify('error', body.message);
  }
});

document.getElementById('code-back-btn')?.addEventListener('click', () => {
  document.getElementById('code-section')!.classList.add('hidden');
  showMethodPicker();
});

window.addEventListener('DOMContentLoaded', init);
