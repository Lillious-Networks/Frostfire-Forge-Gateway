import { sendRequest } from "./socket.js";

interface Particle {
  name: string;
  size?: number;
  opacity?: number;
  color?: string;
  zindex?: number;
  glow_intensity?: number;
  visible?: boolean;
  velocity?: { x: number; y: number };
  gravity?: { x: number; y: number };
  spread?: { x: number; y: number };
  localposition?: { x: number; y: number };
  affected_by_weather?: boolean;
  lifetime?: number;
  interval?: number;
  amount?: number;
  staggertime?: number;
  affected_by_time?: boolean;
  time_on?: string;
  time_off?: string;
  scale?: number;
}

class ParticleEditor {
  public isActive: boolean = false;
  private particles: Particle[] = [];
  private editorWindow: Window | null = null;
  private bridgeReady: boolean = false;
  private messageQueue: any[] = [];
  private windowCloseInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    window.addEventListener('message', this.onMessage.bind(this));
  }

  public toggle() {
    if (this.isActive) {
      this.closeEditor();
    } else {
      this.openEditor();
    }
  }

  private openEditor() {
    this.isActive = true;

    const url = window.location.origin + '/particle-editor';
    this.editorWindow = window.open(url, 'ParticleEditor',
      'width=1100,height=750,left=120,top=80,location=no,toolbar=no,menubar=no,status=no');

    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }

    this.windowCloseInterval = setInterval(() => {
      if (this.editorWindow && this.editorWindow.closed) {
        this.onWindowClosed();
      }
    }, 500);

    this.loadParticles();
  }

  private markBridgeReady() {
    if (!this.bridgeReady) {
      this.bridgeReady = true;
      while (this.messageQueue.length > 0) {
        this.editorWindow!.postMessage(this.messageQueue.shift()!, '*');
      }
    }
  }

  private closeEditor() {
    this.isActive = false;

    if (this.editorWindow && !this.editorWindow.closed) {
      this.editorWindow.postMessage({ type: 'close' }, '*');
      this.editorWindow.close();
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.messageQueue = [];
    if (this.windowCloseInterval) {
      clearInterval(this.windowCloseInterval);
      this.windowCloseInterval = null;
    }
  }

  private onWindowClosed() {
    if (this.windowCloseInterval) {
      clearInterval(this.windowCloseInterval);
      this.windowCloseInterval = null;
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.messageQueue = [];
    this.isActive = false;
  }

  private sendToEditor(msg: any) {
    if (this.bridgeReady && this.editorWindow) {
      this.editorWindow.postMessage(msg, '*');
    } else {
      this.messageQueue.push(msg);
    }
  }

  private onMessage(e: MessageEvent) {
    if (!this.editorWindow || e.source !== this.editorWindow) return;

    // Any message from the editor window means the bridge is alive
    this.markBridgeReady();

    const msg = e.data;
    if (msg.type === 'bridgeReady') {
      this.sendToEditor({ type: 'init', particles: this.particles });
      if (this.particles.length === 0) {
        setTimeout(() => this.loadParticles(), 400);
        setTimeout(() => { if (this.particles.length === 0) this.loadParticles(); }, 1200);
      }
      return;
    }

    switch (msg.type) {
      case 'createParticle':
        this.createParticle(msg.name);
        break;

      case 'deleteParticle':
        this.deleteParticle(msg.name);
        break;

      case 'saveParticle':
        this.saveParticle(msg.particle);
        break;

      case 'requestParticles':
        this.loadParticles();
        break;

      case 'editorClosed':
        if (this.windowCloseInterval) {
          clearInterval(this.windowCloseInterval);
          this.windowCloseInterval = null;
        }
        this.editorWindow = null;
        this.bridgeReady = false;
        this.messageQueue = [];
        this.isActive = false;
        break;
    }
  }

  private loadParticles() {
    sendRequest({ type: 'LIST_PARTICLES', data: null });
  }

  private createParticle(name: string) {
    if (!name) return;

    const newParticle: any = {
      name: name,
      size: 5,
      opacity: 0.8,
      color: '#ffffff',
      zindex: 0,
      glow_intensity: 0,
      visible: true,
      velocity: { x: 0, y: 0 },
      gravity: { x: 0, y: 0 },
      spread: { x: 0, y: 0 },
      localposition: { x: 0, y: 0 },
      affected_by_weather: false,
      lifetime: 1000,
      interval: 100,
      amount: 10,
      staggertime: 0,
      affected_by_time: false,
      time_on: '',
      time_off: '',
      scale: 1,
    };

    sendRequest({
      type: 'SAVE_PARTICLE',
      data: newParticle
    });

    // Reload the list after a brief delay to let the server process the new particle
    setTimeout(() => {
      this.loadParticles();
    }, 300);
  }

  private deleteParticle(name: string) {
    if (!name) return;
    sendRequest({ type: 'DELETE_PARTICLE', data: { name: name } });

    setTimeout(() => {
      this.loadParticles();
    }, 300);
  }

  private saveParticle(particle: any) {
    if (!particle) return;

    const serialized: any = {};
    const skip = { scale: true, currentLife: true, initialVelocity: true, weather: true };
    for (const key in particle) {
      if ((skip as any)[key]) continue;
      const val = particle[key];
      if (typeof val === 'object' && val !== null && ('x' in val)) {
        serialized[key] = val.x + ',' + val.y;
      } else {
        serialized[key] = val;
      }
    }

    sendRequest({ type: 'SAVE_PARTICLE', data: serialized });

    let idx = -1;
    for (let i = 0; i < this.particles.length; i++) {
      if (this.particles[i].name === particle.name) { idx = i; break; }
    }
    if (idx >= 0) {
      this.particles[idx] = particle;
    }
  }

  public setParticles(particles: Particle[]) {
    this.particles = particles;
    this.sendToEditor({ type: 'init', particles: this.particles });
  }

  public addParticleListItem(data: any) {
    let particleListData: any[] | null = null;

    if (Array.isArray(data)) {
      particleListData = data;
    } else if (data && typeof data === 'object') {
      particleListData = data.data || data.particles || data.list;
      if (!Array.isArray(particleListData)) {
        for (const key in data) {
          if (Array.isArray(data[key])) { particleListData = data[key]; break; }
        }
      }
    }

    if (particleListData && particleListData.length > 0) {
      this.particles = particleListData;
      this.sendToEditor({ type: 'init', particles: this.particles });
    }
  }
}

const particleEditor = new ParticleEditor();
(window as any).particleEditor = particleEditor;
export default particleEditor;
