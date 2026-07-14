const login = document.getElementById('login-button');
const guestLogin = document.getElementById('guest-login-link') as HTMLAnchorElement;
const username = document.getElementById('username') as HTMLInputElement;
const password = document.getElementById('password') as HTMLInputElement;
const passwordForm = document.getElementById('password-form-group') as HTMLFormElement;
username.focus();
if (!login) {
  throw new Error('login-button not found');
}

const login_listener = async () => {
    const response = await fetch('/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            username: username.value,
            password: password.value
        }),
    });

    if (response.status === 200) {
        const body = await response.json();
        if (body.requires2FA) {
            window.location.href = '/2fa-challenge';
            return;
        }
        window.Notify('success', body.message);
        passwordForm.innerHTML = `
            <label for="2fa">Code</label>
            <input type="text" id="code" name="code" placeholder="123456" spellcheck="false" autocomplete="off">
        `
        username.disabled = true;
        login.innerHTML = 'Verify';
        login.removeEventListener('click', login_listener);
        login.addEventListener('click', verify_listener);
    } else if (response.status === 301) {
        window.location.href = '/realm-selection';
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
        window.location.href = '/realm-selection';
    } else if (response.status === 200) {
        const body = await response.json();
        if (body.requires2FA) {
            window.location.href = '/2fa-challenge';
        } else if (body.emailVerified) {
            window.Notify('success', 'Email verified. Please sign in.');
            passwordForm.innerHTML = `
                <label for="password">Password</label>
                <input type="password" id="password" name="password" placeholder="••••••••" spellcheck="false" autocomplete="off">
            `
            username.disabled = false;
            password.disabled = false;
            login.innerHTML = 'Login';
            login.removeEventListener('click', verify_listener);
            login.addEventListener('click', login_listener);
        } else if (body.verified) {
            window.location.href = '/realm-selection';
        } else {
            window.Notify('error', body.message || 'Verification failed');
        }
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
};

login.addEventListener('click', login_listener);

guestLogin.addEventListener('click', async (event) => {
    event.preventDefault();
    const response = await fetch('/guest-login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    });
    if (response.status === 301) {
        window.location.href = '/realm-selection';
    } else {
        const body = await response.json();
        window.Notify('error', body.message);
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        login.click();
    }
});
