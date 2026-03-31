

export async function extractFramesFromSpriteSheet(
  image: HTMLImageElement,
  template: SpriteSheetTemplate
): Promise<Map<number, HTMLImageElement>> {
  const frames = new Map<number, HTMLImageElement>();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return frames;
  }

  canvas.width = template.frameWidth;
  canvas.height = template.frameHeight;

  const totalFrames = template.columns * template.rows;
  const loadPromises: Promise<void>[] = [];

  for (let i = 0; i < totalFrames; i++) {
    const col = i % template.columns;
    const row = Math.floor(i / template.columns);

    const sourceX = col * template.frameWidth;
    const sourceY = row * template.frameHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(
      image,
      sourceX, sourceY,
      template.frameWidth, template.frameHeight,
      0, 0,
      template.frameWidth, template.frameHeight
    );

    const frameImage = new Image();
    const dataUrl = canvas.toDataURL('image/png');

    const loadPromise = new Promise<void>((resolve, reject) => {
      frameImage.onload = () => resolve();
      frameImage.onerror = () => {
        reject(new Error(`Failed to load extracted frame ${i}`));
      };
    });

    loadPromises.push(loadPromise);
    frameImage.src = dataUrl;
    frames.set(i, frameImage);
  }

  await Promise.all(loadPromises);

  return frames;
}

export async function buildAnimationFrames(
  spriteSheet: SpriteSheetTemplate,
  animationName: string,
  extractedFrames: Map<number, HTMLImageElement>
): Promise<AnimationFrame[]> {

  let animation: any;
  let animConfig: any;

  if (animationName.includes('_')) {

    const lastUnderscoreIndex = animationName.lastIndexOf('_');
    const baseName = animationName.substring(0, lastUnderscoreIndex);
    const direction = animationName.substring(lastUnderscoreIndex + 1);

    animation = spriteSheet.animations[baseName];

    if (animation?.directions) {
      animConfig = animation.directions[direction];
      if (!animConfig) {

        const firstDirection = Object.keys(animation.directions)[0];
        animConfig = animation.directions[firstDirection];
      }
    } else {
      animConfig = animation;
    }
  } else {

    animation = spriteSheet.animations[animationName];

    if (animation?.directions) {
      animConfig = animation.directions['down'] || animation.directions[Object.keys(animation.directions)[0]];
    } else {

      animConfig = animation;
    }
  }

  if (!animConfig || !animConfig.frames) {
    return [];
  }

  const frameIndices = Array.isArray(animConfig.frames) ? [...animConfig.frames] : [];

  if (frameIndices.length === 0) {
    return [];
  }

  const frames: AnimationFrame[] = [];

  for (const frameIndex of frameIndices) {
    const sourceFrameImage = extractedFrames.get(frameIndex);

    if (!sourceFrameImage) {
      continue;
    }

    frames.push({
      imageElement: sourceFrameImage,
      width: spriteSheet.frameWidth,
      height: spriteSheet.frameHeight,
      delay: animConfig.frameDuration,
      offset: animConfig.offset || { x: 0, y: 0 }
    });
  }
  return frames;
}

export function validateSpriteSheetTemplate(template: any): boolean {
  if (!template) return false;

  const requiredFields = [
    'name',
    'imageSource',
    'frameWidth',
    'frameHeight',
    'columns',
    'rows',
    'animations'
  ];

  for (const field of requiredFields) {
    if (!(field in template)) {
      return false;
    }
  }

  if (template.frameWidth <= 0 || template.frameHeight <= 0) {
    return false;
  }

  if (template.columns <= 0 || template.rows <= 0) {
    return false;
  }

  if (typeof template.animations !== 'object') {
    return false;
  }

  const totalFrames = template.columns * template.rows;

  for (const animName in template.animations) {
    const anim = template.animations[animName];

    if (anim.directions && typeof anim.directions === 'object') {

      for (const directionName in anim.directions) {
        const direction = anim.directions[directionName];

        if (!Array.isArray(direction.frames) || direction.frames.length === 0) {
          return false;
        }

        if (typeof direction.frameDuration !== 'number' || direction.frameDuration <= 0) {
          return false;
        }

        if (typeof direction.loop !== 'boolean') {
          return false;
        }

        for (const frameIdx of direction.frames) {
          if (frameIdx < 0 || frameIdx >= totalFrames) {
            return false;
          }
        }
      }
    } else {

      if (!Array.isArray(anim.frames) || anim.frames.length === 0) {
        return false;
      }

      if (typeof anim.frameDuration !== 'number' || anim.frameDuration <= 0) {
        return false;
      }

      if (typeof anim.loop !== 'boolean') {
        return false;
      }

      for (const frameIdx of anim.frames) {
        if (frameIdx < 0 || frameIdx >= totalFrames) {
          return false;
        }
      }
    }
  }

  return true;
}

export async function preloadSpriteSheetImage(imageSource: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      resolve(image);
    };

    image.onerror = (error) => {
      reject(new Error(`Failed to load sprite sheet image: ${imageSource}`));
    };

    // Set CORS for remote images
    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
      image.crossOrigin = 'anonymous';
    }

    image.src = imageSource;
  });
}
