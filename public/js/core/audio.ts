import { getUserHasInteracted } from "./input.js";
import { musicSlider, effectsSlider, mutedCheckbox } from "./ui.js";

function fadeInMusic(music: HTMLAudioElement, targetVolume: number, duration: number = 2000): void {
    const startTime = performance.now();
    const startVolume = 0;

    function updateVolume() {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease-in curve for smoother fade
        const easedProgress = progress * progress;
        music.volume = startVolume + (targetVolume - startVolume) * easedProgress;

        if (progress < 1) {
            requestAnimationFrame(updateVolume);
        }
    }

    requestAnimationFrame(updateVolume);
}

export async function playMusic(name: string): Promise<void> {
    // Music disabled - gateway does not serve audio files
    return;
}

function startMusicInterval(music: any) {
  setInterval(() => {
    const musicVolume = Number(musicSlider.value);
    music.volume = mutedCheckbox.checked || musicVolume === 0 ? 0 : musicVolume / 100;
  }, 100);
}

export function playAudio(name: string, data: Uint8Array, pitch: number, timestamp: number): void {
  // Keep retrying to play the audio until the user has interacted with the page
  if (!getUserHasInteracted()) {
    setTimeout(() => {
      playAudio(name, data, pitch, timestamp);
    }, 100);
    return;
  }
  // Get mute status
  if (mutedCheckbox.checked) return;
  // Get effects volume
  const volume = effectsSlider.value === "0" ? 0 : Number(effectsSlider.value) / 100;
  // Check if the audio is already cached, if not, inflate the data
  // @ts-expect-error - pako is not defined because it is loaded in the index.html
  const cachedAudio = timestamp < performance.now() - 3.6e+6 ? pako.inflate(new Uint8Array(data),{ to: 'string' }) : audioCache.get(name)|| pako.inflate(new Uint8Array(data), { to: 'string' });
  const audio = new Audio(`data:audio/wav;base64,${cachedAudio}`);
  if (!audio) {
    console.error("Failed to create audio element");
    return;
  }
  audio.playbackRate = pitch;
  audio.volume = volume;
  // Auto play
  audio.autoplay = true;

  try {
    audio.play();
  } catch (e) {
    console.error(e);
  }
}