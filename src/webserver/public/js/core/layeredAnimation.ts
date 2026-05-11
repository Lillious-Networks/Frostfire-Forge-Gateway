

import {
  extractFramesFromSpriteSheet,
  buildAnimationFrames,
  preloadSpriteSheetImage,
  validateSpriteSheetTemplate
} from './spritesheetParser.js';

const spriteSheetCache: SpriteSheetCache = {};

/**
 * Animation Frame Sequence Cache
 * Caches pre-built animation frame sequences to avoid rebuilding them on every animation change
 * Key format: `${spriteName}:${animationName}` (e.g., "body:walk_down")
 */
const animationFrameCache: Map<string, AnimationFrame[]> = new Map();

// Helper to debug cache state
function logCacheState() {
  console.log(`[AnimCache] Current size: ${animationFrameCache.size}, Keys:`, Array.from(animationFrameCache.keys()));
}

// Fetch sprite sheet template from asset server
async function fetchSpriteSheetTemplate(templateUrl: string): Promise<any> {
  try {
    const response = await fetch(templateUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch sprite template: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching sprite template from ${templateUrl}:`, error);
    throw error;
  }
}

// Helper to convert SpriteUrl to SpriteSheetTemplate
async function resolveSpriteUrl(spriteUrl: any): Promise<any> {
  // If it's already a template, return it
  if (spriteUrl.frameWidth) {
    return spriteUrl;
  }

  // If it has templateUrl, fetch the template
  if (spriteUrl.templateUrl) {
    const template = await fetchSpriteSheetTemplate(spriteUrl.templateUrl);

    // Extract base URL from templateUrl
    const baseUrl = spriteUrl.templateUrl.substring(0, spriteUrl.templateUrl.indexOf('?'));
    const assetServerUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/'));

    // Use the provided imageUrl if available (for equipment sprites using shared templates),
    // otherwise convert template's imageSource to full asset server URL
    if (spriteUrl.imageUrl) {
      // Equipment sprite with shared template - use the equipment's specific image
      template.imageSource = spriteUrl.imageUrl;
    } else if (template.imageSource) {
      // Body/head sprite - convert imageSource relative path to full asset server URL
      const baseName = template.imageSource.split('/').pop()?.replace('.png', '');
      if (baseName) {
        template.imageSource = `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(baseName)}`;
      } else {
        template.imageSource = `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(template.name)}`;
      }
    } else {
      template.imageSource = `${assetServerUrl}/sprite-sheet-image?name=${encodeURIComponent(template.name)}`;
    }

    return template;
  }

  // If it only has imageUrl (equipment sprites), construct minimal template
  // Equipment should animate with the same animation states as the body
  if (spriteUrl.imageUrl) {
    const createDirections = (frameDuration: number, loop: boolean) => ({
      down: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      up: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      left: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      right: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      downleft: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      downright: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      upleft: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } },
      upright: { frames: [0], frameDuration, loop, offset: { x: 0, y: 0 } }
    });

    return {
      name: spriteUrl.name,
      imageSource: spriteUrl.imageUrl,
      frameWidth: 64,
      frameHeight: 64,
      columns: 1,
      rows: 1,
      animations: {
        idle: { directions: createDirections(1000, false) },
        walk: { directions: createDirections(150, true) },
        mount_idle: { directions: createDirections(1000, false) },
        mount_walk: { directions: createDirections(200, true) },
        cast_idle: { directions: createDirections(1000, false) },
        cast_walk: { directions: createDirections(150, true) }
      }
    };
  }

  throw new Error(`Invalid sprite data: ${JSON.stringify(spriteUrl)}`);
}

export async function initializeLayeredAnimation(
  mountSprite: Nullable<SpriteSheetTemplate>,
  bodySprite: Nullable<SpriteSheetTemplate>,
  headSprite: Nullable<SpriteSheetTemplate>,
  armorHelmetSprite: Nullable<SpriteSheetTemplate>,
  armorShoulderguardsSprite: Nullable<SpriteSheetTemplate>,
  armorNeckSprite: Nullable<SpriteSheetTemplate>,
  armorHandsSprite: Nullable<SpriteSheetTemplate>,
  armorChestSprite: Nullable<SpriteSheetTemplate>,
  armorFeetSprite: Nullable<SpriteSheetTemplate>,
  armorLegsSprite: Nullable<SpriteSheetTemplate>,
  armorWeaponSprite: Nullable<SpriteSheetTemplate>,
  initialAnimation: string = 'idle'
): Promise<LayeredAnimation> {

  // Resolve sprite URLs to full templates (handles both SpriteUrl and SpriteSheetTemplate)
  let resolvedMount = mountSprite;
  let resolvedBody = bodySprite;
  let resolvedHead = headSprite;
  let resolvedArmorHelmet = armorHelmetSprite;
  let resolvedArmorShoulderguards = armorShoulderguardsSprite;
  let resolvedArmorNeck = armorNeckSprite;
  let resolvedArmorHands = armorHandsSprite;
  let resolvedArmorChest = armorChestSprite;
  let resolvedArmorFeet = armorFeetSprite;
  let resolvedArmorLegs = armorLegsSprite;
  let resolvedArmorWeapon = armorWeaponSprite;

  // Resolve any SpriteUrl objects to full templates
  if (mountSprite && ((mountSprite as any).templateUrl || (mountSprite as any).imageUrl)) {
    resolvedMount = await resolveSpriteUrl(mountSprite);
  }
  if (bodySprite && ((bodySprite as any).templateUrl || (bodySprite as any).imageUrl)) {
    resolvedBody = await resolveSpriteUrl(bodySprite);
  }
  if (headSprite && ((headSprite as any).templateUrl || (headSprite as any).imageUrl)) {
    resolvedHead = await resolveSpriteUrl(headSprite);
  }
  if (armorHelmetSprite && ((armorHelmetSprite as any).templateUrl || (armorHelmetSprite as any).imageUrl)) {
    resolvedArmorHelmet = await resolveSpriteUrl(armorHelmetSprite);
  }
  if (armorShoulderguardsSprite && ((armorShoulderguardsSprite as any).templateUrl || (armorShoulderguardsSprite as any).imageUrl)) {
    resolvedArmorShoulderguards = await resolveSpriteUrl(armorShoulderguardsSprite);
  }
  if (armorNeckSprite && ((armorNeckSprite as any).templateUrl || (armorNeckSprite as any).imageUrl)) {
    resolvedArmorNeck = await resolveSpriteUrl(armorNeckSprite);
  }
  if (armorHandsSprite && ((armorHandsSprite as any).templateUrl || (armorHandsSprite as any).imageUrl)) {
    resolvedArmorHands = await resolveSpriteUrl(armorHandsSprite);
  }
  if (armorChestSprite && ((armorChestSprite as any).templateUrl || (armorChestSprite as any).imageUrl)) {
    resolvedArmorChest = await resolveSpriteUrl(armorChestSprite);
  }
  if (armorFeetSprite && ((armorFeetSprite as any).templateUrl || (armorFeetSprite as any).imageUrl)) {
    resolvedArmorFeet = await resolveSpriteUrl(armorFeetSprite);
  }
  if (armorLegsSprite && ((armorLegsSprite as any).templateUrl || (armorLegsSprite as any).imageUrl)) {
    resolvedArmorLegs = await resolveSpriteUrl(armorLegsSprite);
  }
  if (armorWeaponSprite && ((armorWeaponSprite as any).templateUrl || (armorWeaponSprite as any).imageUrl)) {
    resolvedArmorWeapon = await resolveSpriteUrl(armorWeaponSprite);
  }

  if (resolvedMount && !validateSpriteSheetTemplate(resolvedMount)) {
    throw new Error('Invalid mount sprite sheet template');
  }
  if (resolvedBody && !validateSpriteSheetTemplate(resolvedBody)) {
    throw new Error('Invalid body sprite sheet template');
  }
  if (resolvedHead && !validateSpriteSheetTemplate(resolvedHead)) {
    throw new Error('Invalid head sprite sheet template');
  }
  if (resolvedArmorHelmet && !validateSpriteSheetTemplate(resolvedArmorHelmet)) {
    throw new Error('Invalid armor helmet sprite sheet template');
  }
  if (resolvedArmorShoulderguards && !validateSpriteSheetTemplate(resolvedArmorShoulderguards)) {
    throw new Error('Invalid armor shoulderguards sprite sheet template');
  }
  if (resolvedArmorNeck && !validateSpriteSheetTemplate(resolvedArmorNeck)) {
    throw new Error('Invalid armor neck sprite sheet template');
  }
  if (resolvedArmorHands && !validateSpriteSheetTemplate(resolvedArmorHands)) {
    throw new Error('Invalid armor hands sprite sheet template');
  }
  if (resolvedArmorChest && !validateSpriteSheetTemplate(resolvedArmorChest)) {
    throw new Error('Invalid armor chest sprite sheet template');
  }
  if (resolvedArmorFeet && !validateSpriteSheetTemplate(resolvedArmorFeet)) {
    throw new Error('Invalid armor feet sprite sheet template');
  }
  if (resolvedArmorLegs && !validateSpriteSheetTemplate(resolvedArmorLegs)) {
    throw new Error('Invalid armor legs sprite sheet template');
  }
  if (resolvedArmorWeapon && !validateSpriteSheetTemplate(resolvedArmorWeapon)) {
    throw new Error('Invalid armor weapon sprite sheet template');
  }

  const isMounted = resolvedMount !== null;

  const mountLayer = resolvedMount
    ? await createAnimationLayer('mount', resolvedMount, initialAnimation, -1, false)
    : null;

  const bodyLayer = resolvedBody
    ? await createAnimationLayer('body', resolvedBody, initialAnimation, 0, isMounted)
    : null;

  const armorNeckLayer = resolvedArmorNeck
    ? await createAnimationLayer('armor_neck', resolvedArmorNeck, initialAnimation, 1, isMounted)
    : null;

  const armorHandsLayer = resolvedArmorHands
    ? await createAnimationLayer('armor_hands', resolvedArmorHands, initialAnimation, 2, isMounted)
    : null;

  const armorChestLayer = resolvedArmorChest
    ? await createAnimationLayer('armor_chest', resolvedArmorChest, initialAnimation, 3, isMounted)
    : null;

  const armorFeetLayer = resolvedArmorFeet
    ? await createAnimationLayer('armor_feet', resolvedArmorFeet, initialAnimation, 4, isMounted)
    : null;

  const armorLegsLayer = resolvedArmorLegs
    ? await createAnimationLayer('armor_legs', resolvedArmorLegs, initialAnimation, 5, isMounted)
    : null;

  const headLayer = resolvedHead
    ? await createAnimationLayer('head', resolvedHead, initialAnimation, 6, isMounted)
    : null;

  const armorHelmetLayer = resolvedArmorHelmet
    ? await createAnimationLayer('armor_helmet', resolvedArmorHelmet, initialAnimation, 7, isMounted)
    : null;

  const armorShoulderguardsLayer = resolvedArmorShoulderguards
    ? await createAnimationLayer('armor_shoulderguards', resolvedArmorShoulderguards, initialAnimation, 8, isMounted)
    : null;

  const armorWeaponLayer = resolvedArmorWeapon
    ? await createAnimationLayer('armor_weapon', resolvedArmorWeapon, initialAnimation, 9, isMounted)
    : null;

  return {
    layers: {
      mount: mountLayer as AnimationLayer,
      body: bodyLayer as AnimationLayer,
      head: headLayer as AnimationLayer,
      armor_helmet: armorHelmetLayer as AnimationLayer,
      armor_shoulderguards: armorShoulderguardsLayer as AnimationLayer,
      armor_neck: armorNeckLayer as AnimationLayer,
      armor_hands: armorHandsLayer as AnimationLayer,
      armor_chest: armorChestLayer as AnimationLayer,
      armor_feet: armorFeetLayer as AnimationLayer,
      armor_legs: armorLegsLayer as AnimationLayer,
      armor_weapon: armorWeaponLayer as AnimationLayer
    },
    currentAnimationName: initialAnimation
  };
}

async function createAnimationLayer(
  type: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_shoulderguards' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon',
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  zIndex: number,
  isMounted: boolean = false
): Promise<AnimationLayer> {

  const normalizedName = spriteSheet.name.toLowerCase();
  const imageSource = (spriteSheet as any).imageData || spriteSheet.imageSource;
  const cacheKey = `${normalizedName}:${imageSource}`;

  if (!spriteSheetCache[cacheKey]) {

    const image = await preloadSpriteSheetImage(imageSource);

    const extractedFramesMap = await extractFramesFromSpriteSheet(image, spriteSheet);

    const extractedFrames: { [frameIndex: number]: HTMLImageElement } = {};
    if (extractedFramesMap instanceof Map) {
      extractedFramesMap.forEach((value, key) => {
        extractedFrames[key] = value;
      });
    } else {
      Object.assign(extractedFrames, extractedFramesMap);
    }

    const clonedTemplate = JSON.parse(JSON.stringify(spriteSheet));

    spriteSheetCache[cacheKey] = {
      imageElement: image,
      template: clonedTemplate,
      extractedFrames
    };
  }

  const cached = spriteSheetCache[cacheKey];

  let actualAnimationName = animationName;
  const isArmorLayer = type.startsWith('armor_');
  if (isMounted && (type === 'body' || type === 'head' || isArmorLayer)) {
    if (animationName.startsWith('idle_')) {

      actualAnimationName = animationName.replace('idle_', 'mount_idle_');
    } else if (animationName.startsWith('walk_')) {

      actualAnimationName = animationName.replace('walk_', 'mount_walk_');
    }
  }

  const frameCacheKey = `${type}:${normalizedName}`;
  console.log(`[InitLayer] ${type}: caching frames for ${actualAnimationName} (sprite: ${spriteSheet.name}, normalized: ${normalizedName}, cache key: ${frameCacheKey})`);
  const frames = await getOrBuildAnimationFrames(
    frameCacheKey,
    actualAnimationName,
    spriteSheet,
    new Map<number, HTMLImageElement>(Object.entries(cached.extractedFrames).map(([k, v]) => [Number(k), v]))
  );

  const layer: any = {
    type,
    spriteSheet,
    frames,
    currentFrame: 0,
    lastFrameTime: performance.now(),
    zIndex,
    visible: true,
    _cacheKey: cacheKey
  };
  return layer as AnimationLayer;
}

export function updateLayeredAnimation(
  layeredAnim: LayeredAnimation,
  deltaTime: number
): void {
  const now = performance.now();
  const layers = Object.values(layeredAnim.layers).filter(l => l !== null) as AnimationLayer[];

  if (layers.length === 0) return;

  // Update each layer's animation independently based on its frame duration
  for (const layer of layers) {
    if (layer.frames.length === 0) continue;

    // Initialize lastFrameTime if not set
    if (!layer.lastFrameTime) {
      layer.lastFrameTime = now;
      layer.currentFrame = 0;
    }

    const currentFrame = layer.frames[layer.currentFrame];
    if (!currentFrame) continue;

    const frameDuration = currentFrame.delay || 125;

    // Advance frame when enough time has elapsed
    if (now - layer.lastFrameTime >= frameDuration) {
      layer.currentFrame = (layer.currentFrame + 1) % layer.frames.length;
      layer.lastFrameTime += frameDuration;
    }
  }
}

/**
 * Get or build animation frames with caching
 * Avoids rebuilding frame sequences on every animation change
 */
async function getOrBuildAnimationFrames(
  spriteName: string,
  animationName: string,
  spriteSheet: SpriteSheetTemplate,
  extractedFrames: Map<number, HTMLImageElement>
): Promise<AnimationFrame[]> {
  const cacheKey = `${spriteName}:${animationName}`;

  // Return cached frames if available
  if (animationFrameCache.has(cacheKey)) {
    console.log(`[AnimCache] HIT: ${cacheKey}`);
    logCacheState();
    return animationFrameCache.get(cacheKey)!;
  }

  // Build and cache the frames
  console.log(`[AnimCache] MISS: ${cacheKey} - building frames...`);
  const frames = await buildAnimationFrames(spriteSheet, animationName, extractedFrames);
  animationFrameCache.set(cacheKey, frames);
  console.log(`[AnimCache] STORED: ${cacheKey}`);
  logCacheState();
  return frames;
}

export async function changeLayeredAnimation(
  layeredAnim: LayeredAnimation,
  newAnimationName: string
): Promise<void> {
  if (layeredAnim.currentAnimationName === newAnimationName) return;

  console.log(`[Anim] Changing animation to: ${newAnimationName}`);
  layeredAnim.currentAnimationName = newAnimationName;

  const isMounted = layeredAnim.layers.mount !== null;

  // Group layers by template to batch updates - reduces from 10+ individual operations to 2-3 template groups
  const layersByTemplate = new Map<string, AnimationLayer[]>();

  for (const layer of Object.values(layeredAnim.layers)) {
    if (!layer || !layer.spriteSheet) continue;

    const cacheKey = (layer as any)._cacheKey;
    if (!layersByTemplate.has(cacheKey)) {
      layersByTemplate.set(cacheKey, []);
    }
    layersByTemplate.get(cacheKey)!.push(layer);
  }

  // Update layers grouped by template
  const templateUpdates = Array.from(layersByTemplate.entries()).map(async ([cacheKey, layersWithSameTemplate]) => {
    const cached = spriteSheetCache[cacheKey];
    if (!cached) return;

    // All layers in this group share the same template, so check once
    for (const layer of layersWithSameTemplate) {
      let actualAnimationName = newAnimationName;

      const isArmorLayer = layer.type.startsWith('armor_');

      if (isMounted && (layer.type === 'body' || layer.type === 'head' || isArmorLayer)) {
        if (newAnimationName.startsWith('idle_')) {
          actualAnimationName = newAnimationName.replace('idle_', 'mount_idle_');
        } else if (newAnimationName.startsWith('walk_')) {
          actualAnimationName = newAnimationName.replace('walk_', 'mount_walk_');
        }
      } else if (layer.type === 'mount') {
        actualAnimationName = newAnimationName;
      }

      // Check if animation exists
      let animationExists = false;
      if (cached.template.animations[actualAnimationName]) {
        animationExists = true;
      } else if (actualAnimationName.includes('_')) {
        const lastUnderscoreIndex = actualAnimationName.lastIndexOf('_');
        const baseName = actualAnimationName.substring(0, lastUnderscoreIndex);
        const direction = actualAnimationName.substring(lastUnderscoreIndex + 1);
        if (cached.template.animations[baseName]?.directions?.[direction]) {
          animationExists = true;
        }
      }

      if (!animationExists) continue;

      // Update this layer's frames
      const spriteName = (layer.spriteSheet as any).name || layer.type;
      const normalizedSpriteName = spriteName.toLowerCase();
      const frameCacheKey = `${layer.type}:${normalizedSpriteName}`;
      console.log(`[Anim] Layer ${layer.type}: requesting frames for ${actualAnimationName} (sprite: ${spriteName}, normalized: ${normalizedSpriteName}, cache key: ${frameCacheKey})`);
      layer.frames = await getOrBuildAnimationFrames(
        frameCacheKey,
        actualAnimationName,
        cached.template,
        new Map<number, HTMLImageElement>(Object.entries(cached.extractedFrames).map(([k, v]) => [Number(k), v]))
      );

      // Reset this layer's animation state
      layer.currentFrame = 0;
      layer.lastFrameTime = performance.now();
    }
  });

  // Don't block rendering - update animations asynchronously
  // This allows the animation change to be visible immediately, with layers updating in the background
  Promise.all(templateUpdates).catch(err => console.error('Error updating animation layers:', err));
}

export function getVisibleLayersSorted(layeredAnim: LayeredAnimation): AnimationLayer[] {
  const layers = Object.values(layeredAnim.layers)
    .filter(l => l !== null && l.visible) as AnimationLayer[];

  const animName = layeredAnim.currentAnimationName;
  const direction = animName.split('_').pop() || '';
  const isUpDirection = direction === 'up' || direction === 'upleft' || direction === 'upright';
  const isLeftDirection = direction === 'left' || direction === 'upleft';

  return layers.map(layer => {

    if (isUpDirection) {
      if (layer.type === 'armor_shoulderguards') {

        return { ...layer, zIndex: 5.3 };
      }
      if (layer.type === 'armor_weapon') {

        return { ...layer, zIndex: -2 };
      }
    }

    if (isLeftDirection) {
      if (layer.type === 'armor_weapon') {

        return { ...layer, zIndex: -2 };
      }
    }
    return layer;
  }).sort((a, b) => a.zIndex - b.zIndex);
}

/**
 * Clear the animation frame cache
 * Useful for memory management or testing
 */
export function clearAnimationFrameCache(): void {
  animationFrameCache.clear();
}

/**
 * Get animation frame cache statistics
 * Returns the number of cached animation sequences
 */
export function getAnimationFrameCacheStats(): { size: number; entries: string[] } {
  return {
    size: animationFrameCache.size,
    entries: Array.from(animationFrameCache.keys())
  };
}

