

import { mount } from './input.js';

interface JoystickState {
    active: boolean;
    touchId: number | null;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
}

const state: JoystickState = {
    active: false,
    touchId: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
};

const CONFIG = {
    maxDistance: 35,
    deadzone: 0.05,
    updateRate: 16
};

const container = document.getElementById('virtual-joystick-container') as HTMLElement;
const stick = document.getElementById('virtual-joystick-stick') as HTMLElement;

function handleTouchStart(event: TouchEvent): void {

    event.preventDefault();

    if (state.touchId !== null || event.touches.length !== 1) {
        return;
    }

    const touch = event.touches[0];
    const rect = container.getBoundingClientRect();

    state.touchId = touch.identifier;
    state.active = true;
    state.startX = rect.left + rect.width / 2;
    state.startY = rect.top + rect.height / 2;
    state.currentX = touch.clientX;
    state.currentY = touch.clientY;

    stick.classList.add('active');
}

function handleTouchMove(event: TouchEvent): void {

    event.preventDefault();

    if (!state.active || state.touchId === null) {
        return;
    }

    const touch = Array.from(event.touches).find(
        t => t.identifier === state.touchId
    );

    if (!touch) {
        return;
    }

    state.currentX = touch.clientX;
    state.currentY = touch.clientY;

    requestAnimationFrame(updateStickPosition);
}

function handleTouchEnd(event: TouchEvent): void {
    if (state.touchId === null) {
        return;
    }

    const touchStillActive = Array.from(event.touches).some(
        t => t.identifier === state.touchId
    );

    if (!touchStillActive) {
        resetJoystick();
    }
}

function handleTouchCancel(event: TouchEvent): void {
    handleTouchEnd(event);
}

function updateStickPosition(): void {
    if (!stick || !state.active) {
        return;
    }

    const deltaX = state.currentX - state.startX;
    const deltaY = state.currentY - state.startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    let x = deltaX;
    let y = deltaY;

    if (distance > CONFIG.maxDistance) {
        const angle = Math.atan2(deltaY, deltaX);
        x = Math.cos(angle) * CONFIG.maxDistance;
        y = Math.sin(angle) * CONFIG.maxDistance;
    }

    stick.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function resetJoystick(): void {
    state.active = false;
    state.touchId = null;

    if (stick) {
        stick.style.transform = 'translate(-50%, -50%)';
        stick.classList.remove('active');
    }

    dispatchJoystickEvent(0, 0);
}

function getNormalizedInput(): { x: number; y: number } {
    if (!state.active) {
        return { x: 0, y: 0 };
    }

    const deltaX = state.currentX - state.startX;
    const deltaY = state.currentY - state.startY;

    let x = deltaX / CONFIG.maxDistance;
    let y = deltaY / CONFIG.maxDistance;

    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));

    const magnitude = Math.sqrt(x * x + y * y);
    if (magnitude < CONFIG.deadzone) {
        return { x: 0, y: 0 };
    }

    return { x, y };
}

function dispatchJoystickEvent(x: number, y: number): void {
    const event = new CustomEvent('gamepadjoystick', {
        detail: {
            x,
            y,
            type: 'left',
            isVirtual: true
        }
    });

    window.dispatchEvent(event);
}

function startUpdateLoop(): void {
    let lastUpdate = 0;

    function update(timestamp: number): void {

        if (timestamp - lastUpdate >= CONFIG.updateRate) {
            const input = getNormalizedInput();

            if (input.x !== 0 || input.y !== 0 || state.active) {
                dispatchJoystickEvent(input.x, input.y);
            }

            lastUpdate = timestamp;
        }

        requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

function initialize(): void {

    if (!container || !stick) return;

    if (!('ontouchstart' in window)) return;

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    container.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    startUpdateLoop();
}

function initializeMountButton(): void {
    const mountButton = document.getElementById('virtual-mount-button') as HTMLElement;

    if (!mountButton) return;

    if (!('ontouchstart' in window)) {
        return;
    }

    mountButton.addEventListener('click', (event) => {
        event.preventDefault();

        mount();
    });

}

initialize();
initializeMountButton();
