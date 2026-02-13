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

let currentMusic: HTMLAudioElement | null = null;

export async function playMusic(name: string): Promise<void> {
    // Keep retrying until the user has interacted with the page
    if (!getUserHasInteracted()) {
        setTimeout(() => {
            playMusic(name);
        }, 100);
        return;
    }

    // Stop current music if playing
    if (currentMusic) {
        currentMusic.pause();
        currentMusic = null;
    }

    try {
        // Add .mp3 extension if not present
        const musicFileName = name.endsWith('.mp3') ? name : `${name}.mp3`;

        // Fetch music from gateway
        const response = await fetch(`/music?name=${encodeURIComponent(musicFileName)}`);
        if (!response.ok) {
            console.error(`Failed to fetch music: ${response.statusText}`);
            return;
        }

        // Create audio element from blob
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const music = new Audio(url);

        // Set initial volume and loop
        music.loop = true;
        music.volume = 0;

        // Start playing
        await music.play();

        // Store reference to current music
        currentMusic = music;

        // Fade in the music
        const targetVolume = mutedCheckbox.checked ? 0 : Number(musicSlider.value) / 100;
        fadeInMusic(music, targetVolume);

        // Start volume monitoring interval
        startMusicInterval(music);

        // Clean up blob URL when music ends (shouldn't happen with loop=true, but good practice)
        music.addEventListener('ended', () => {
            URL.revokeObjectURL(url);
        });
    } catch (error) {
        console.error("Failed to play music:", error);
    }
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