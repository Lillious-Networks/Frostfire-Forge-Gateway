const register = document.getElementById('register-button') as HTMLButtonElement;
const email = document.getElementById('register-email') as HTMLInputElement;
email.focus();
const username = document.getElementById('register-username') as HTMLInputElement;
const password = document.getElementById('register-password') as HTMLInputElement;
const password2 = document.getElementById('register-confirm-password') as HTMLInputElement;
const registerForm = document.getElementById('register-fields') as HTMLDivElement;

if (!register) {
  throw new Error('register not found');
}

const register_listener = async () => {
  const response = await fetch('/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email.value,
      username: username.value,
      password: password.value,
      password2: password2.value
    }),
  });

  if (response.status === 200) {
      window.Notify('success', 'Verification email sent');
      registerForm.innerHTML = `
          <label for="2fa">Verification Code</label>
          <input type="text" id="code" name="code" placeholder="123456" spellcheck="false" autocomplete="off">
      `
      email.disabled = true;
      username.disabled = true;
      password.disabled = true;
      password2.disabled = true;
      register.innerHTML = 'Verify';
      register.removeEventListener('click', register_listener);
      register.addEventListener('click', verify_listener);
  } else {
      const body = await response.json();
      window.Notify('error', body.message);
  }
};

const verify_listener = async () => {
    const code = (document.getElementById('code') as HTMLInputElement)?.value?.trim().toUpperCase();
    const params = new URLSearchParams({ username: username.value, code });
    const response = await fetch(`/verify?${params.toString()}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        redirect: 'manual',
    });
    if (response.status === 301 || response.type === 'opaqueredirect') {
        window.location.href = '/game';
    } else if (response.status === 200) {
        const body = await response.json();
        if (body.requires2FA) {
            window.location.href = '/2fa-challenge';
        } else if (body.verified) {
            window.location.href = '/game';
        } else {
            window.Notify('error', body.message || 'Verification failed');
        }
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
};

register.addEventListener('click', register_listener);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    register.click();
  }
});
