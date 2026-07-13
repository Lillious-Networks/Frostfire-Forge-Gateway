declare global {
  interface Window {
    Notify: (type: string, message: string, time?: number) => void;
  }
}

const currentURL = new URL(window.location.href);
const resetEmail = currentURL.searchParams.get("email");
const resetCode = currentURL.searchParams.get("code");
const reset2fa = currentURL.searchParams.get("require2fa") === "1";
const isResetMode = !!(resetEmail && resetCode);

function getToken(): string {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'token') return value;
  }
  return '';
}

let totpEnabled = false;
let global2faEnabled = false;

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

async function loadProfile() {
  const token = getToken();
  if (!token) {
    if (isResetMode) {
      initResetMode();
      return;
    }
    window.location.href = '/';
    return;
  }

  try {
    const response = await fetch('/api/profile', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (response.status === 401) {
      window.location.href = '/';
      return;
    }
    const profile = await response.json();

    const loadingEl = document.getElementById('profile-loading');
    const contentEl = document.getElementById('profile-content');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

    document.getElementById('profile-username')!.textContent = profile.username;
    profileEmailMasked = profile.email_masked || '********';
    document.getElementById('profile-email')!.textContent = profileEmailMasked;
    document.getElementById('profile-lastlogin')!.textContent = profile.last_login ? new Date(profile.last_login).toLocaleString() : 'Never';

    (document.getElementById('require-webauthn') as HTMLInputElement).checked = profile.require_webauthn;
    (document.getElementById('require-totp') as HTMLInputElement).checked = profile.require_totp;
    (document.getElementById('require-email') as HTMLInputElement).checked = profile.require_email_2fa;

    updateCheckboxStates(profile);

    updateSecurityBanner();

    totpEnabled = profile.totp_enabled;
    global2faEnabled = profile.global_2fa_enabled;

    const totpBadge = document.getElementById('totp-badge')!;
    const totpEnableBtn = document.getElementById('totp-enable-btn')!;
    const totpDisableBtn = document.getElementById('totp-disable-btn')!;
    if (profile.totp_enabled) {
      totpBadge.textContent = 'Enabled';
      totpBadge.className = 'badge badge-on';
      totpEnableBtn.classList.add('hidden');
      totpDisableBtn.classList.remove('hidden');
    } else {
      totpBadge.textContent = 'Disabled';
      totpBadge.className = 'badge badge-off';
      totpEnableBtn.classList.remove('hidden');
      totpDisableBtn.classList.add('hidden');
    }

    const webauthnBadge = document.getElementById('webauthn-badge')!;
    const webauthnKeys = profile.webauthn_credentials || [];
    if (webauthnKeys.length > 0) {
      webauthnBadge.textContent = `${webauthnKeys.length} key${webauthnKeys.length > 1 ? 's' : ''}`;
      webauthnBadge.className = 'badge badge-on';
    } else {
      webauthnBadge.textContent = 'No keys';
      webauthnBadge.className = 'badge badge-off';
    }

    renderWebAuthnKeys(webauthnKeys);
  } catch {
    window.Notify('error', 'Failed to load profile');
  }
}

function initResetMode() {
  document.getElementById('profile-loading')!.classList.add('hidden');
  document.getElementById('reset-password-section')!.classList.remove('hidden');
  document.getElementById('reset-email-display')!.textContent = resetEmail!;
  if (reset2fa) {
    document.getElementById('reset-totp-group')!.classList.remove('hidden');
  }
}

function renderWebAuthnKeys(keys: Array<{ id: string; name: string; createdAt: string }>) {
  const listEl = document.getElementById('webauthn-keys-list')!;
  listEl.innerHTML = '';

  if (keys.length === 0) {
    listEl.innerHTML = '<div class="empty-note">No security keys registered</div>';
    return;
  }

  for (const key of keys) {
    const div = document.createElement('div');
    div.className = 'key-item';
    div.innerHTML = `
      <div>
        <div class="key-label">${key.name}</div>
        <div class="key-meta">Added ${new Date(key.createdAt).toLocaleDateString()}</div>
      </div>
      <button class="btn-outline btn-outline-danger remove-key-btn" data-key-id="${key.id}">Remove</button>
    `;
    listEl.appendChild(div);
  }

  document.querySelectorAll('.remove-key-btn').forEach((btn) => {
    btn.addEventListener('click', async function (this: HTMLElement) {
      const keyId = this.dataset.keyId!;
      const keyName = this.closest('.key-item')?.querySelector('.key-label')?.textContent || 'this key';
      showRemoveKeyModal(keyId, keyName);
    });
  });
}

// ========== Reset Password (email link flow) ==========
document.getElementById('reset-generate-password-btn')?.addEventListener('click', async () => {
  try {
    const password = await generatePasswordFromServer();
    (document.getElementById('reset-new-password') as HTMLInputElement).value = password;
    (document.getElementById('reset-confirm-password') as HTMLInputElement).value = password;
    document.getElementById('reset-new-password')?.focus();
    window.Notify('success', 'Secure password generated');
  } catch {
    window.Notify('error', 'Failed to generate password');
  }
});

document.getElementById('reset-password-btn')?.addEventListener('click', async () => {
  const password = (document.getElementById('reset-new-password') as HTMLInputElement).value;
  const confirm = (document.getElementById('reset-confirm-password') as HTMLInputElement).value;
  const totpCode = (document.getElementById('reset-totp') as HTMLInputElement).value;

  if (!password || !confirm) {
    window.Notify('error', 'All fields are required');
    return;
  }
  if (password !== confirm) {
    window.Notify('error', 'Passwords do not match');
    return;
  }

  const body: Record<string, string> = {
    email: resetEmail!,
    password,
    password2: confirm,
    code: resetCode!,
  };

  if (reset2fa) {
    if (!totpCode || totpCode.length !== 6) {
      window.Notify('error', 'Authenticator code is required');
      return;
    }
    body.totp = totpCode;
  }

  const response = await fetch('/update-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (response.ok) {
    window.Notify('success', 'Password updated. Redirecting to login...');
    setTimeout(() => { window.location.href = '/'; }, 3000);
  } else {
    window.Notify('error', data.message);
  }
});

// ========== Change Email ==========
let pendingNewEmail = '';
let emailChangePassword = '';
let emailChangeStep: 'old' | 'new' = 'old';

document.getElementById('change-email-btn')?.addEventListener('click', () => {
  const newEmail = (document.getElementById('new-email') as HTMLInputElement).value.trim();
  if (!newEmail) {
    window.Notify('error', 'Email is required');
    return;
  }
  pendingNewEmail = newEmail;
  emailChangePassword = '';
  emailChangeStep = 'old';

  showEmailChangeModal('password');
});

function showEmailChangeModal(step: 'password' | 'totp' | 'code') {
  document.getElementById('email-2fa-password')!.classList.add('hidden');
  document.getElementById('email-2fa-totp')!.classList.add('hidden');
  document.getElementById('email-2fa-code')!.classList.add('hidden');
  (document.getElementById('email-2fa-password-input') as HTMLInputElement).value = '';
  (document.getElementById('email-2fa-totp-input') as HTMLInputElement).value = '';
  (document.getElementById('email-2fa-code-input') as HTMLInputElement).value = '';

  if (step === 'password') {
    document.getElementById('email-2fa-title')!.textContent = 'Confirm Password';
    document.getElementById('email-2fa-desc')!.textContent = 'Enter your account password to change your email.';
    document.getElementById('email-2fa-password')!.classList.remove('hidden');
    (document.getElementById('email-2fa-password-input') as HTMLInputElement).focus();
  } else if (step === 'totp') {
    document.getElementById('email-2fa-title')!.textContent = 'Authenticator Code';
    document.getElementById('email-2fa-desc')!.textContent = 'Enter your authenticator code to continue.';
    document.getElementById('email-2fa-totp')!.classList.remove('hidden');
    (document.getElementById('email-2fa-totp-input') as HTMLInputElement).focus();
  } else {
    document.getElementById('email-2fa-code')!.classList.remove('hidden');
    (document.getElementById('email-2fa-code-input') as HTMLInputElement).focus();
  }

  document.getElementById('email-2fa-modal')!.classList.remove('hidden');
}

document.getElementById('email-2fa-cancel')?.addEventListener('click', () => {
  document.getElementById('email-2fa-modal')!.classList.add('hidden');
  pendingNewEmail = '';
  emailChangePassword = '';
  emailChangeStep = 'old';
});

document.getElementById('email-2fa-submit')?.addEventListener('click', async () => {
  const passwordVisible = !document.getElementById('email-2fa-password')!.classList.contains('hidden');
  const totpVisible = !document.getElementById('email-2fa-totp')!.classList.contains('hidden');
  const codeVisible = !document.getElementById('email-2fa-code')!.classList.contains('hidden');

  if (passwordVisible) {
    const pwd = (document.getElementById('email-2fa-password-input') as HTMLInputElement).value;
    if (!pwd) {
      window.Notify('error', 'Password is required');
      return;
    }
    emailChangePassword = pwd;

    if (global2faEnabled && totpEnabled) {
      showEmailChangeModal('totp');
      return;
    }

    sendEmailChangeRequest();
    return;
  }

  if (totpVisible) {
    const totpCode = (document.getElementById('email-2fa-totp-input') as HTMLInputElement).value.trim();
    if (!totpCode || totpCode.length !== 6) {
      window.Notify('error', 'Enter a valid 6-digit code');
      return;
    }
    document.getElementById('email-2fa-modal')!.classList.add('hidden');
    sendEmailChangeRequest(totpCode);
    return;
  }

  if (codeVisible) {
    const code = (document.getElementById('email-2fa-code-input') as HTMLInputElement).value.trim();
    if (!code || code.length !== 6) {
      window.Notify('error', 'Enter a valid 6-digit code');
      return;
    }

    const token = getToken();
    const requestBody: Record<string, string> = { email: pendingNewEmail, password: emailChangePassword };

    if (emailChangeStep === 'old') {
      requestBody.oldEmailCode = code;
    } else {
      requestBody.emailCode = code;
    }

    const response = await fetch('/api/profile/change-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(requestBody),
    });

    const body = await response.json();
    if (!response.ok) {
      window.Notify('error', body.message);
      return;
    }

    if (body.requiresNewCode) {
      emailChangeStep = 'new';
      document.getElementById('email-2fa-title')!.textContent = 'Verify New Email';
      document.getElementById('email-2fa-desc')!.textContent = `A verification code was sent to ${pendingNewEmail}. Enter it to confirm.`;
      (document.getElementById('email-2fa-code-input') as HTMLInputElement).value = '';
      document.getElementById('email-2fa-code-input')?.focus();
      return;
    }

    document.getElementById('email-2fa-modal')!.classList.add('hidden');
    window.Notify('success', body.message);
    revealedEmail = '';
    showingRevealed = false;
    profileEmailMasked = body.email_masked || pendingNewEmail;
    document.getElementById('profile-email')!.textContent = profileEmailMasked;
    (document.getElementById('new-email') as HTMLInputElement).value = '';
    pendingNewEmail = '';
    emailChangePassword = '';
  }
});

async function sendEmailChangeRequest(totp?: string) {
  const token = getToken();
  const requestBody: Record<string, string> = { email: pendingNewEmail, password: emailChangePassword };
  if (totp) requestBody.totp = totp;

  const response = await fetch('/api/profile/change-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(requestBody),
  });

  const body = await response.json();
  if (!response.ok) {
    document.getElementById('email-2fa-modal')!.classList.add('hidden');
    window.Notify('error', body.message);
    return;
  }

  emailChangeStep = 'old';
  document.getElementById('email-2fa-title')!.textContent = 'Verify Current Email';
  document.getElementById('email-2fa-desc')!.textContent = `A verification code was sent to ${body.oldEmailMasked}. Enter it to continue.`;
  showEmailChangeModal('code');
}

// ========== Change Password ==========
async function generatePasswordFromServer(): Promise<string> {
  const token = getToken();
  const response = await fetch('/api/profile/generate-password', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const body = await response.json();
  return body.password;
}

document.getElementById('generate-password-btn')?.addEventListener('click', async () => {
  try {
    const password = await generatePasswordFromServer();
    (document.getElementById('new-password') as HTMLInputElement).value = password;
    (document.getElementById('confirm-password') as HTMLInputElement).value = password;
    document.getElementById('new-password')?.focus();
    window.Notify('success', 'Secure password generated');
  } catch {
    window.Notify('error', 'Failed to generate password');
  }
});

document.getElementById('change-password-btn')?.addEventListener('click', async () => {
  const currentPassword = (document.getElementById('current-password') as HTMLInputElement).value;
  const newPassword = (document.getElementById('new-password') as HTMLInputElement).value;
  const confirmPassword = (document.getElementById('confirm-password') as HTMLInputElement).value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    window.Notify('error', 'All fields are required');
    return;
  }
  if (newPassword !== confirmPassword) {
    window.Notify('error', 'Passwords do not match');
    return;
  }

  if (global2faEnabled && totpEnabled) {
    show2FAModal('totp');
    return;
  }

  if (global2faEnabled && !totpEnabled) {
    window.Notify('success', 'Sending verification email...');
    const token = getToken();
    const response = await fetch('/api/profile/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = await response.json();
    if (response.ok && body.requiresEmail) {
      show2FAModal('email');
    } else if (response.ok) {
      clearPasswordFields();
      window.Notify('success', body.message);
    } else {
      window.Notify('error', body.message);
    }
    return;
  }

  doPasswordChange();
});

function show2FAModal(type: 'totp' | 'email') {
  const modal = document.getElementById('password-2fa-modal')!;
  const title = document.getElementById('password-2fa-title')!;
  const totpGroup = document.getElementById('password-2fa-totp')!;
  const emailGroup = document.getElementById('password-2fa-email')!;
  const totpInput = document.getElementById('password-2fa-totp-input') as HTMLInputElement;
  const emailInput = document.getElementById('password-2fa-email-input') as HTMLInputElement;

  totpGroup.classList.add('hidden');
  emailGroup.classList.add('hidden');
  totpInput.value = '';
  emailInput.value = '';

  if (type === 'totp') {
    title.textContent = 'Authenticator Code';
    totpGroup.classList.remove('hidden');
    totpInput.focus();
  } else {
    title.textContent = 'Email Verification';
    emailGroup.classList.remove('hidden');
    emailInput.focus();
  }

  modal.classList.remove('hidden');
}

document.getElementById('password-2fa-cancel')?.addEventListener('click', () => {
  document.getElementById('password-2fa-modal')!.classList.add('hidden');
});

document.getElementById('password-2fa-submit')?.addEventListener('click', async () => {
  const totpVisible = !document.getElementById('password-2fa-totp')!.classList.contains('hidden');
  const totpCode = (document.getElementById('password-2fa-totp-input') as HTMLInputElement).value;
  const emailCode = (document.getElementById('password-2fa-email-input') as HTMLInputElement).value;

  if (totpVisible && (!totpCode || totpCode.length !== 6)) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }
  if (!totpVisible && (!emailCode || emailCode.length !== 6)) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }

  const currentPassword = (document.getElementById('current-password') as HTMLInputElement).value;
  const newPassword = (document.getElementById('new-password') as HTMLInputElement).value;

  const requestBody: Record<string, string> = { currentPassword, newPassword };
  if (totpVisible) {
    requestBody.totp = totpCode;
  } else {
    requestBody.emailCode = emailCode;
  }

  const token = getToken();
  const response = await fetch('/api/profile/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(requestBody),
  });

  const body = await response.json();
  if (response.ok) {
    document.getElementById('password-2fa-modal')!.classList.add('hidden');
    clearPasswordFields();
    window.Notify('success', body.message);
  } else {
    window.Notify('error', body.message);
  }
});

function doPasswordChange() {
  const currentPassword = (document.getElementById('current-password') as HTMLInputElement).value;
  const newPassword = (document.getElementById('new-password') as HTMLInputElement).value;

  const token = getToken();
  fetch('/api/profile/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ currentPassword, newPassword }),
  }).then(async (response) => {
    const body = await response.json();
    if (response.ok) {
      clearPasswordFields();
      window.Notify('success', body.message);
    } else {
      window.Notify('error', body.message);
    }
  });
}

function clearPasswordFields() {
  (document.getElementById('current-password') as HTMLInputElement).value = '';
  (document.getElementById('new-password') as HTMLInputElement).value = '';
  (document.getElementById('confirm-password') as HTMLInputElement).value = '';
}

// ========== 2FA Requirements Toggle ==========
let isUpdatingCheckbox = false;

document.querySelectorAll('input[data-method]').forEach((cb) => {
  cb.addEventListener('change', async function (this: HTMLInputElement) {
    if (isUpdatingCheckbox) return;
    const method = this.dataset.method!;
    const value = this.checked;

    if (value) {
      const token = getToken();
      const response = await fetch('/api/profile/2fa-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ method, value: true }),
      });
      const body = await response.json();
      if (response.ok) {
        updateAllCheckboxes(body);
        const labels: Record<string, string> = {
          webauthn: 'Security Key will be required for sign-in',
          totp: 'Authenticator App will be required for sign-in',
          email: 'Email verification will be required for sign-in',
        };
        window.Notify('success', labels[method] || 'Method enabled');
      } else {
        revertCheckbox(method);
        window.Notify('error', body.message);
      }
      return;
    }

    this.checked = true;
    if (method === 'webauthn') {
      await disableWebAuthnRequirement();
    } else if (method === 'totp') {
      showDisableTotpRequirementModal();
    } else if (method === 'email') {
      showDisableEmailRequirementModal();
    }
  });
});

function revertCheckbox(method: string) {
  isUpdatingCheckbox = true;
  const map: Record<string, string> = { webauthn: 'require-webauthn', totp: 'require-totp', email: 'require-email' };
  const cb = document.getElementById(map[method]) as HTMLInputElement;
  if (cb) cb.checked = true;
  isUpdatingCheckbox = false;
}

function updateAllCheckboxes(body: any) {
  isUpdatingCheckbox = true;
  (document.getElementById('require-webauthn') as HTMLInputElement).checked = body.requireWebAuthn;
  (document.getElementById('require-totp') as HTMLInputElement).checked = body.requireTotp;
  (document.getElementById('require-email') as HTMLInputElement).checked = body.requireEmail2FA;
  isUpdatingCheckbox = false;
  updateSecurityBanner();
}

function updateCheckboxStates(profile?: any) {
  const cbWebAuthn = document.getElementById('require-webauthn') as HTMLInputElement;
  const cbTotp = document.getElementById('require-totp') as HTMLInputElement;
  const cbEmail = document.getElementById('require-email') as HTMLInputElement;

  if (profile) {
    const webauthnKeys = profile.webauthn_credentials || [];
    cbWebAuthn.disabled = webauthnKeys.length === 0;
    cbTotp.disabled = !profile.totp_enabled;
    cbEmail.disabled = !profile.global_2fa_enabled;
  } else {
    cbWebAuthn.disabled = document.querySelectorAll('.key-item').length === 0;
    cbTotp.disabled = !totpEnabled;
    cbEmail.disabled = !global2faEnabled;
  }
}

function updateSecurityBanner() {
  const banner = document.getElementById('security-banner')!;
  const anyEnabled = (document.getElementById('require-webauthn') as HTMLInputElement).checked
    || (document.getElementById('require-totp') as HTMLInputElement).checked
    || (document.getElementById('require-email') as HTMLInputElement).checked;
  if (anyEnabled) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

async function disableWebAuthnRequirement() {
  if (!window.isSecureContext || !navigator?.credentials) {
    revertCheckbox('webauthn');
    window.Notify('error', 'WebAuthn requires HTTPS or localhost');
    return;
  }

  try {
    const token = getToken();
    const response = await fetch('/api/profile/2fa-requirements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ method: 'webauthn', value: false }),
    });

    const body = await response.json();
    if (response.ok && body.requiresWebAuthn) {
      const optionsResponse = await fetch('/api/profile/auth-webauthn', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!optionsResponse.ok) {
        revertCheckbox('webauthn');
        window.Notify('error', 'Failed to start WebAuthn');
        return;
      }

      const options = await optionsResponse.json();
      const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: base64UrlToBuffer(options.challenge),
        rpId: options.rpId,
        allowCredentials: options.allowCredentials.map((cred: any) => ({ type: 'public-key', id: base64UrlToBuffer(cred.id) })),
        timeout: options.timeout,
        userVerification: options.userVerification,
      };

      const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
      if (!credential) throw new Error('Failed');

      const credResponse = credential.response as AuthenticatorAssertionResponse;
      const verifyResponse = await fetch('/api/profile/2fa-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          method: 'webauthn',
          value: false,
          webauthnResponse: {
            credentialId: credential.id,
            clientDataJSON: bufferToBase64Url(credResponse.clientDataJSON),
            authenticatorData: bufferToBase64Url(credResponse.authenticatorData),
            signature: bufferToBase64Url(credResponse.signature),
          },
        }),
      });

      const verifyBody = await verifyResponse.json();
      if (verifyResponse.ok) {
        updateAllCheckboxes(verifyBody);
        window.Notify('success', 'Requirement disabled');
      } else {
        window.Notify('error', verifyBody.message);
      }
    } else if (response.ok) {
      updateAllCheckboxes(body);
    } else {
      window.Notify('error', body.message);
    }
  } catch (err: any) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      revertCheckbox('webauthn');
    } else {
      window.Notify('error', err.message || 'Verification failed');
    }
  }
}

function showDisableTotpRequirementModal() {
  (document.getElementById('disable-totp-code') as HTMLInputElement).value = '';
  document.getElementById('disable-totp-modal')!.classList.remove('hidden');
  document.getElementById('disable-totp-code')?.focus();
}

document.getElementById('disable-totp-cancel')?.addEventListener('click', () => {
  document.getElementById('disable-totp-modal')!.classList.add('hidden');
  revertCheckbox('totp');
});

document.getElementById('disable-totp-submit')?.addEventListener('click', async () => {
  const code = (document.getElementById('disable-totp-code') as HTMLInputElement).value.trim();
  if (!code || code.length !== 6) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/profile/2fa-requirements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ method: 'totp', value: false, totp: code }),
  });

  const body = await response.json();
  if (response.ok) {
    document.getElementById('disable-totp-modal')!.classList.add('hidden');
    updateAllCheckboxes(body);
    window.Notify('success', 'Authenticator requirement disabled');
  } else {
    window.Notify('error', body.message);
  }
});

function showDisableEmailRequirementModal() {
  (document.getElementById('disable-email-code') as HTMLInputElement).value = '';
  document.getElementById('disable-email-modal')!.classList.remove('hidden');
  document.getElementById('disable-email-code')?.focus();

  const token = getToken();
  fetch('/api/profile/2fa-requirements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ method: 'email', value: false }),
  }).then(async (response) => {
    const body = await response.json();
    if (response.ok && body.requiresEmail) {
      window.Notify('success', body.message || 'Verification email sent');
    } else if (response.ok) {
      document.getElementById('disable-email-modal')!.classList.add('hidden');
      updateAllCheckboxes(body);
    } else {
      document.getElementById('disable-email-modal')!.classList.add('hidden');
      window.Notify('error', body.message);
    }
  });
}

document.getElementById('disable-email-cancel')?.addEventListener('click', () => {
  document.getElementById('disable-email-modal')!.classList.add('hidden');
  revertCheckbox('email');
});

document.getElementById('disable-email-submit')?.addEventListener('click', async () => {
  const code = (document.getElementById('disable-email-code') as HTMLInputElement).value.trim();
  if (!code || code.length !== 6) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }

  const token = getToken();
  const verifyResponse = await fetch('/api/profile/2fa-requirements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ method: 'email', value: false, emailCode: code }),
  });

  const verifyBody = await verifyResponse.json();
  if (verifyResponse.ok) {
    document.getElementById('disable-email-modal')!.classList.add('hidden');
    updateAllCheckboxes(verifyBody);
    window.Notify('success', 'Email requirement disabled');
  } else {
    window.Notify('error', verifyBody.message);
  }
});

// ========== TOTP ==========
document.getElementById('totp-enable-btn')?.addEventListener('click', () => {
  document.getElementById('totp-setup-password')!.classList.remove('hidden');
  document.getElementById('totp-setup-qr')!.classList.add('hidden');
  (document.getElementById('totp-setup-password-input') as HTMLInputElement).value = '';
  document.getElementById('totp-setup-modal')!.classList.remove('hidden');
  document.getElementById('totp-setup-password-input')?.focus();
});

document.getElementById('totp-setup-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('totp-setup-modal')!.classList.add('hidden');
});

document.getElementById('totp-qr-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('totp-setup-modal')!.classList.add('hidden');
});

document.getElementById('totp-setup-password-btn')?.addEventListener('click', async () => {
  const password = (document.getElementById('totp-setup-password-input') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/profile/setup-totp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ password }),
  });

  const body = await response.json();
  if (response.ok) {
    document.getElementById('totp-setup-password')!.classList.add('hidden');
    document.getElementById('totp-setup-qr')!.classList.remove('hidden');
    const qrImg = document.getElementById('totp-qr') as HTMLImageElement;
    qrImg.style.visibility = 'hidden';
    qrImg.onload = () => { qrImg.style.visibility = 'visible'; };
    qrImg.src = body.qrUrl;
    (document.getElementById('totp-code') as HTMLInputElement).value = '';
    document.getElementById('totp-code')?.focus();
  } else {
    window.Notify('error', body.message);
  }
});

document.getElementById('totp-verify-btn')?.addEventListener('click', async () => {
  const code = (document.getElementById('totp-code') as HTMLInputElement).value;
  if (!code || code.length !== 6) {
    window.Notify('error', 'Enter a valid 6-digit code');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/profile/verify-totp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });

  const body = await response.json();
  if (response.ok) {
    document.getElementById('totp-setup-modal')!.classList.add('hidden');
    window.Notify('success', 'Authenticator app enabled');
    document.getElementById('totp-badge')!.textContent = 'Enabled';
    document.getElementById('totp-badge')!.className = 'badge badge-on';
    document.getElementById('totp-enable-btn')!.classList.add('hidden');
    document.getElementById('totp-disable-btn')!.classList.remove('hidden');
    totpEnabled = true;
    updateCheckboxStates();
  } else {
    window.Notify('error', body.message);
  }
});

let pendingTotpRemovePassword = '';
let isAwaitingTotpRemoveCode = false;

document.getElementById('totp-disable-btn')?.addEventListener('click', () => {
  pendingTotpRemovePassword = '';
  isAwaitingTotpRemoveCode = false;
  (document.getElementById('totp-remove-password') as HTMLInputElement).value = '';
  document.getElementById('totp-remove-message')!.textContent = '';
  document.getElementById('totp-remove-message')!.className = '';
  document.getElementById('totp-remove-modal')!.classList.remove('hidden');
  document.getElementById('totp-remove-password')?.focus();
});

document.getElementById('totp-remove-cancel')?.addEventListener('click', () => {
  document.getElementById('totp-remove-modal')!.classList.add('hidden');
});

document.getElementById('totp-remove-submit')?.addEventListener('click', async () => {
  if (isAwaitingTotpRemoveCode) {
    const code = (document.getElementById('totp-remove-password') as HTMLInputElement).value.trim();
    if (!code || code.length !== 6) {
      window.Notify('error', 'Enter a valid 6-digit code');
      return;
    }

    const token = getToken();
    const response = await fetch('/api/profile/disable-totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ password: pendingTotpRemovePassword, emailCode: code }),
    });

    const body = await response.json();
    if (response.ok) {
      document.getElementById('totp-remove-modal')!.classList.add('hidden');
      window.Notify('success', body.message);
      document.getElementById('totp-badge')!.textContent = 'Disabled';
      document.getElementById('totp-badge')!.className = 'badge badge-off';
      document.getElementById('totp-enable-btn')!.classList.remove('hidden');
      document.getElementById('totp-disable-btn')!.classList.add('hidden');
      totpEnabled = false;
      pendingTotpRemovePassword = '';
      isAwaitingTotpRemoveCode = false;
    } else {
      window.Notify('error', body.message);
    }
    return;
  }

  const password = (document.getElementById('totp-remove-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  pendingTotpRemovePassword = password;
  const token = getToken();
  const response = await fetch('/api/profile/disable-totp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ password }),
  });

  const body = await response.json();
  if (response.ok && body.requiresEmail) {
    isAwaitingTotpRemoveCode = true;
    const label = document.querySelector('#totp-remove-modal label')!;
    label.textContent = 'Verification Code';
    const input = document.getElementById('totp-remove-password') as HTMLInputElement;
    input.type = 'text';
    input.placeholder = 'Email code';
    input.value = '';
    input.focus();
  } else if (response.ok) {
    document.getElementById('totp-remove-modal')!.classList.add('hidden');
    window.Notify('success', body.message);
    document.getElementById('totp-badge')!.textContent = 'Disabled';
    document.getElementById('totp-badge')!.className = 'badge badge-off';
    document.getElementById('totp-enable-btn')!.classList.remove('hidden');
    document.getElementById('totp-disable-btn')!.classList.add('hidden');
    totpEnabled = false;
    updateCheckboxStates();
  } else {
    window.Notify('error', body.message);
  }
});

// ========== WebAuthn ==========
document.getElementById('webauthn-add-btn')?.addEventListener('click', () => {
  document.getElementById('webauthn-key-modal')!.classList.remove('hidden');
  (document.getElementById('webauthn-key-name') as HTMLInputElement).value = '';
  document.getElementById('webauthn-key-name')?.focus();
});

document.getElementById('webauthn-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('webauthn-key-modal')!.classList.add('hidden');
  (document.getElementById('webauthn-key-name') as HTMLInputElement).value = '';
});

document.getElementById('webauthn-register-btn')?.addEventListener('click', async () => {
  const keyName = (document.getElementById('webauthn-key-name') as HTMLInputElement).value || 'Security Key';
  const token = getToken();

  if (!window.isSecureContext || !navigator?.credentials) {
    window.Notify('error', 'WebAuthn requires HTTPS or localhost. Your browser supports it but this page must be served over a secure connection.');
    return;
  }

  try {
    const optionsResponse = await fetch('/api/profile/register-webauthn', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!optionsResponse.ok) {
      const err = await optionsResponse.json();
      window.Notify('error', err.message);
      return;
    }

    const options = await optionsResponse.json();

    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: base64UrlToBuffer(options.challenge),
      rp: options.rp,
      user: {
        id: base64UrlToBuffer(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
    };

    if (options.excludeCredentials && options.excludeCredentials.length > 0) {
      publicKey.excludeCredentials = options.excludeCredentials.map((cred: any) => ({
        type: 'public-key',
        id: base64UrlToBuffer(cred.id),
      }));
    }

    const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential;
    if (!credential) throw new Error('Failed to create credential');

    const credResponse = credential.response as AuthenticatorAttestationResponse;

    const verifyResponse = await fetch('/api/profile/verify-webauthn-registration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        keyName,
        credentialId: credential.id,
        clientDataJSON: bufferToBase64Url(credResponse.clientDataJSON),
        attestationObject: bufferToBase64Url(credResponse.attestationObject),
      }),
    });

    const verifyBody = await verifyResponse.json();
    if (verifyResponse.ok) {
      window.Notify('success', 'Security key registered');
      document.getElementById('webauthn-key-modal')!.classList.add('hidden');
      (document.getElementById('webauthn-key-name') as HTMLInputElement).value = '';

      const keys = verifyBody.credentials || [];
      renderWebAuthnKeys(keys);
      updateWebAuthnBadge(keys.length);
      updateCheckboxStates();
    } else {
      window.Notify('error', verifyBody.message);
    }
  } catch (err: any) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      window.Notify('error', err.message || 'WebAuthn registration failed');
    }
    document.getElementById('webauthn-key-modal')!.classList.add('hidden');
  }
});

async function removeWebAuthnKey(keyId: string, password: string, totp?: string) {
  const token = getToken();
  const requestBody: Record<string, string> = { credentialId: keyId, password };
  if (totp) requestBody.totp = totp;

  const response = await fetch('/api/profile/remove-webauthn', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const body = await response.json();
  if (response.ok) {
    const keys = body.credentials || [];
    renderWebAuthnKeys(keys);
    updateWebAuthnBadge(keys.length);
    updateAllCheckboxes(body);
    updateCheckboxStates();
    window.Notify('success', 'Security key removed');
  } else {
    window.Notify('error', body.message);
  }
}

let pendingRemoveKeyId = '';
let pendingRemovePassword = '';
let isAwaitingEmailCode = false;

function showRemoveKeyModal(keyId: string, keyName: string) {
  pendingRemoveKeyId = keyId;
  pendingRemovePassword = '';
  isAwaitingEmailCode = false;
  document.getElementById('remove-key-desc')!.textContent = `Enter your password to remove "${keyName}".`;
  (document.getElementById('remove-key-password') as HTMLInputElement).value = '';
  (document.getElementById('remove-key-totp-input') as HTMLInputElement).value = '';
  document.getElementById('remove-key-totp')!.classList.add('hidden');
  document.getElementById('remove-key-password')!.parentElement!.classList.remove('hidden');
  const totpLabel = document.getElementById('remove-key-totp')!.querySelector('label')!;
  totpLabel.textContent = 'Authenticator Code';
  document.getElementById('remove-key-message')!.textContent = '';
  document.getElementById('remove-key-message')!.className = '';

  document.getElementById('remove-key-modal')!.classList.remove('hidden');
  document.getElementById('remove-key-password')?.focus();
}

document.getElementById('remove-key-cancel')?.addEventListener('click', () => {
  document.getElementById('remove-key-modal')!.classList.add('hidden');
  pendingRemoveKeyId = '';
  pendingRemovePassword = '';
  isAwaitingEmailCode = false;
});

document.getElementById('remove-key-submit')?.addEventListener('click', async () => {
  if (isAwaitingEmailCode) {
    const code = (document.getElementById('remove-key-totp-input') as HTMLInputElement).value.trim();
    if (!code || code.length !== 6) {
      window.Notify('error', 'Enter a valid 6-digit code');
      return;
    }

    const token = getToken();
    const response = await fetch('/api/profile/remove-webauthn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ credentialId: pendingRemoveKeyId, password: pendingRemovePassword, emailCode: code }),
    });

    const body = await response.json();
    if (response.ok) {
      document.getElementById('remove-key-modal')!.classList.add('hidden');
      const keys = body.credentials || [];
      renderWebAuthnKeys(keys);
      updateWebAuthnBadge(keys.length);
      updateAllCheckboxes(body);
      updateCheckboxStates();
      window.Notify('success', 'Security key removed');
      pendingRemoveKeyId = '';
      pendingRemovePassword = '';
      isAwaitingEmailCode = false;
    } else {
      window.Notify('error', body.message);
    }
    return;
  }

  const password = (document.getElementById('remove-key-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  if (global2faEnabled && totpEnabled) {
    const totpInput = document.getElementById('remove-key-totp-input') as HTMLInputElement;
    const totpCode = totpInput.value.trim();
    const totpVisible = !document.getElementById('remove-key-totp')!.classList.contains('hidden');

    if (!totpVisible) {
      pendingRemovePassword = password;
      document.getElementById('remove-key-totp')!.classList.remove('hidden');
      totpInput.value = '';
      totpInput.focus();
      return;
    }

    if (!totpCode || totpCode.length !== 6) {
      window.Notify('error', 'Enter a valid 6-digit code');
      return;
    }

    document.getElementById('remove-key-modal')!.classList.add('hidden');
    await removeWebAuthnKey(pendingRemoveKeyId, password, totpCode);
    pendingRemoveKeyId = '';
    return;
  }

  if (global2faEnabled && !totpEnabled) {
    window.Notify('success', 'Sending verification email...');
    pendingRemovePassword = password;
    const token = getToken();
    const response = await fetch('/api/profile/remove-webauthn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ credentialId: pendingRemoveKeyId, password }),
    });
    const body = await response.json();
    if (response.ok && body.requiresEmail) {
      isAwaitingEmailCode = true;
      document.getElementById('remove-key-desc')!.textContent = 'A verification code was sent to your email. Enter it to confirm.';
      document.getElementById('remove-key-password')!.parentElement!.classList.add('hidden');
      document.getElementById('remove-key-totp')!.querySelector('label')!.textContent = 'Verification Code';
      const totpInput = document.getElementById('remove-key-totp-input') as HTMLInputElement;
      totpInput.value = '';
      document.getElementById('remove-key-totp')!.classList.remove('hidden');
      document.getElementById('remove-key-message')!.textContent = '';
      document.getElementById('remove-key-message')!.className = '';
      totpInput.focus();
    } else if (response.ok) {
      document.getElementById('remove-key-modal')!.classList.add('hidden');
      const keys = body.credentials || [];
      renderWebAuthnKeys(keys);
      updateWebAuthnBadge(keys.length);
      updateAllCheckboxes(body);
      updateCheckboxStates();
      window.Notify('success', 'Security key removed');
      pendingRemoveKeyId = '';
    } else {
      window.Notify('error', body.message);
    }
    return;
  }

  document.getElementById('remove-key-modal')!.classList.add('hidden');
  await removeWebAuthnKey(pendingRemoveKeyId, password);
  pendingRemoveKeyId = '';
});

function updateWebAuthnBadge(count: number) {
  const badge = document.getElementById('webauthn-badge')!;
  if (count > 0) {
    badge.textContent = `${count} key${count > 1 ? 's' : ''}`;
    badge.className = 'badge badge-on';
  } else {
    badge.textContent = 'No keys';
    badge.className = 'badge badge-off';
  }
}

// ========== Reveal Email ==========
let revealedEmail = '';
let showingRevealed = false;

function showRevealedEmail() {
  document.getElementById('profile-email')!.textContent = revealedEmail;
  showingRevealed = true;
}

function showMaskedEmail() {
  document.getElementById('profile-email')!.textContent = profileEmailMasked || '********';
  showingRevealed = false;
}

document.getElementById('reveal-email-btn')?.addEventListener('click', () => {
  if (revealedEmail) {
    if (showingRevealed) {
      showMaskedEmail();
    } else {
      showRevealedEmail();
    }
    return;
  }
  document.getElementById('reveal-email-modal')!.classList.remove('hidden');
  (document.getElementById('reveal-password') as HTMLInputElement).value = '';
  document.getElementById('reveal-password')?.focus();
});

document.getElementById('reveal-email-cancel')?.addEventListener('click', () => {
  document.getElementById('reveal-email-modal')!.classList.add('hidden');
  (document.getElementById('reveal-password') as HTMLInputElement).value = '';
});

document.getElementById('reveal-email-submit')?.addEventListener('click', async () => {
  const password = (document.getElementById('reveal-password') as HTMLInputElement).value;
  if (!password) {
    window.Notify('error', 'Password is required');
    return;
  }

  const token = getToken();
  const response = await fetch('/api/profile/reveal-email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ password }),
  });

  const body = await response.json();
  if (response.ok) {
    revealedEmail = body.email;
    showRevealedEmail();
    document.getElementById('reveal-email-modal')!.classList.add('hidden');
    (document.getElementById('reveal-password') as HTMLInputElement).value = '';
  } else {
    window.Notify('error', body.message);
  }
});

document.getElementById('reveal-email-modal')?.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'reveal-email-modal') {
    document.getElementById('reveal-email-modal')!.classList.add('hidden');
    (document.getElementById('reveal-password') as HTMLInputElement).value = '';
  }
});

let profileEmailMasked = '';

window.addEventListener('DOMContentLoaded', loadProfile);
