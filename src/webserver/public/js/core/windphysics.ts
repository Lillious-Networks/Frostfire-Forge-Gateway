// Wind burst system constants
export const WIND_BURST_CYCLE = 3000; // Total cycle duration in ms
export const WIND_BURST_RAMP_UP = 400; // Time to ramp up to full intensity in ms
export const WIND_BURST_HOLD = 200; // Time to hold full intensity in ms
export const WIND_BURST_RAMP_DOWN = 400; // Time to ramp down from full intensity in ms

export class WindBurstTracker {
  private windBurstIntensity: number = 0; // 0 to 1
  private windBurstTimer: number = 0;

  update(deltaTimeMs: number): void {
    this.windBurstTimer += deltaTimeMs;
    if (this.windBurstTimer >= WIND_BURST_CYCLE) {
      this.windBurstTimer -= WIND_BURST_CYCLE;
    }

    // Calculate wind burst intensity with gradual ramp up, hold, and ramp down
    const BURST_RAMP_UP_END = WIND_BURST_RAMP_UP;
    const BURST_HOLD_END = BURST_RAMP_UP_END + WIND_BURST_HOLD;
    const BURST_RAMP_DOWN_END = BURST_HOLD_END + WIND_BURST_RAMP_DOWN;

    if (this.windBurstTimer < BURST_RAMP_UP_END) {
      // Ramp up phase: gradually increase from 0 to 1
      this.windBurstIntensity =
        (this.windBurstTimer / WIND_BURST_RAMP_UP) * Math.sin(Math.PI / 2);
    } else if (this.windBurstTimer < BURST_HOLD_END) {
      // Hold phase: maintain full intensity
      this.windBurstIntensity = 1;
    } else if (this.windBurstTimer < BURST_RAMP_DOWN_END) {
      // Ramp down phase: gradually decrease from 1 to 0
      const rampDownProgress =
        (this.windBurstTimer - BURST_HOLD_END) / WIND_BURST_RAMP_DOWN;
      this.windBurstIntensity = Math.cos(rampDownProgress * Math.PI / 2);
    } else {
      // Rest phase: no wind burst
      this.windBurstIntensity = 0;
    }
  }

  getIntensity(): number {
    return this.windBurstIntensity;
  }

  reset(): void {
    this.windBurstTimer = 0;
    this.windBurstIntensity = 0;
  }
}

// Shared instance used by all systems (particle editor, NPCs, entities, weather)
export const windBurst = new WindBurstTracker();

export function calculateWindSpeed(
  baseWindSpeed: number,
  burstIntensity: number
): number {
  // Base wind always applied, burst adds up to 50% more
  return baseWindSpeed + baseWindSpeed * burstIntensity * 0.5;
}

export function applyWindVelocity(
  vx: number,
  vy: number,
  windSpeed: number,
  windDirection: string | null,
  maxVelX: number,
  maxVelY: number
): { vx: number; vy: number } {
  let newVx: number;

  if (
    windDirection &&
    windSpeed > 0 &&
    (windDirection === "left" || windDirection === "right")
  ) {
    const windDirectionRad =
      (windDirection === "left" ? 180 : 0) * (Math.PI / 180);
    const windVelX = Math.cos(windDirectionRad) * windSpeed * 0.5;

    // Clamp velocity toward wind direction (allow wind to push horizontally only)
    newVx = Math.min(Math.max(vx, -maxVelX + windVelX), maxVelX + windVelX);
  } else {
    // No wind - clamp normally
    newVx = Math.min(Math.max(vx, -maxVelX), maxVelX);
  }

  // Vertical velocity always clamped normally
  const newVy = Math.min(Math.max(vy, -maxVelY), maxVelY);

  return { vx: newVx, vy: newVy };
}

export function getWindBias(
  windSpeed: number,
  windDirection: string | null
): { x: number; y: number } {
  const bias = { x: 0, y: 0 };

  if (
    windDirection !== null &&
    (windDirection === "left" || windDirection === "right")
  ) {
    const windDirectionRad =
      (windDirection === "left" ? 180 : windDirection === "right" ? 0 : 180) *
      (Math.PI / 180);
    bias.x = Math.cos(windDirectionRad) * windSpeed * 0.5;
    bias.y = Math.sin(windDirectionRad) * windSpeed * 0.5;
  }

  return bias;
}
