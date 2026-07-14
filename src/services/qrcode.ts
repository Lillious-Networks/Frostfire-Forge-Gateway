const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

// Capacity in codewords for versions 3-5, error correction level M
const VERSION_CAPACITY: Record<number, { data: number; ec: number; total: number }> = {
  3: { data: 38, ec: 18, total: 56 },
  4: { data: 52, ec: 24, total: 76 },
  5: { data: 68, ec: 30, total: 98 },
};

// Alignment pattern positions per version
const ALIGNMENT: Record<number, number[]> = {
  3: [6, 22],
  4: [6, 24],
  5: [6, 26],
};

// Generator polynomial coefficients for GF(256)
const EXP_TABLE: number[] = [];
const LOG_TABLE: number[] = new Array(256);

function initGaloisField() {
  if (EXP_TABLE.length > 0) return;
  let x = 1;
  for (let i = 0; i < 256; i++) {
    EXP_TABLE[i] = x;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 0; i < 255; i++) {
    LOG_TABLE[EXP_TABLE[i]] = i;
  }
}

function generateECCodewords(data: number[], ecCount: number): number[] {
  initGaloisField();
  const precomputed: Record<number, number[]> = {
    18: [1, 157, 87, 146, 116, 179, 227, 125, 190, 146, 89, 66, 117, 212, 209, 149, 242, 191, 189],
    24: [1, 204, 167, 104, 205, 96, 53, 235, 232, 32, 52, 140, 249, 235, 134, 61, 196, 201, 73, 24, 191, 166, 87, 221, 131],
    30: [1, 100, 180, 174, 254, 159, 32, 111, 216, 178, 196, 252, 144, 203, 165, 117, 83, 81, 9, 254, 210, 202, 59, 96, 145, 177, 19, 39, 5, 188, 216],
  };
  return computeRemainder(data, precomputed[ecCount] || []);
}

function computeRemainder(data: number[], generator: number[]): number[] {
  const result = new Array(data.length + generator.length - 1).fill(0);
  for (let i = 0; i < data.length; i++) result[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    if (result[i] === 0) continue;
    const factor = LOG_TABLE[result[i]];
    for (let j = 0; j < generator.length; j++) {
      result[i + j] ^= EXP_TABLE[(LOG_TABLE[generator[j]] + factor) % 255];
    }
  }
  return result.slice(data.length);
}

function encodeAlphanumeric(text: string): number[] {
  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  for (let i = 0; i < text.length; i += 2) {
    if (i + 1 < text.length) {
      const v = ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]);
      pushBits(v, 11);
    } else {
      pushBits(ALPHANUMERIC.indexOf(text[i]), 6);
    }
  }
  return bits;
}

function selectVersion(dataBits: number): number {
  for (const v of [3, 4, 5]) {
    if (VERSION_CAPACITY[v].data * 8 >= dataBits) return v;
  }
  return 5;
}

export function generateQRDataUri(text: string, size: number = 200): string {
  const upperText = text.toUpperCase();
  const dataBits = encodeAlphanumeric(upperText);
  const version = Math.min(selectVersion(dataBits.length), 5);
  const cap = VERSION_CAPACITY[version];
  const dimension = 17 + version * 4;

  // Pad data bits
  const terminator = Math.min(4, cap.data * 8 - dataBits.length);
  for (let i = 0; i < terminator; i++) dataBits.push(0);
  while (dataBits.length % 8 !== 0) dataBits.push(0);
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (dataBits.length < cap.data * 8) {
    const b = padBytes[pi % 2];
    for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);
    pi++;
  }

  // Convert bits to codewords
  const dataCodewords: number[] = [];
  for (let i = 0; i < dataBits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | (dataBits[i + j] || 0);
    dataCodewords.push(val);
  }

  // Error correction
  const ecCodewords = generateECCodewords(dataCodewords, cap.ec);

  // Build final message
  const message = [...dataCodewords, ...ecCodewords];

  // Create module matrix
  const matrix: number[][] = Array.from({ length: dimension }, () => new Array(dimension).fill(-1));

  // Finder patterns
  const addFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        if (row + r < 0 || col + c < 0 || row + r >= dimension || col + c >= dimension) continue;
        const inPattern = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const inCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (inPattern) {
          matrix[row + r][col + c] = (inCenter || r === 0 || r === 6 || c === 0 || c === 6) ? 1 : 0;
        } else if (r === -1 || r === 7 || c === -1 || c === 7) {
          matrix[row + r][col + c] = 0;
        }
      }
    }
  };

  addFinder(3, 3);
  addFinder(3, dimension - 4);
  addFinder(dimension - 4, 3);

  // Timing patterns
  for (let i = 8; i < dimension - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Dark module
  matrix[dimension - 8][8] = 1;

  // Alignment patterns (version >= 2)
  const alignPos = ALIGNMENT[version] || [];
  for (const ar of alignPos) {
    for (const ac of alignPos) {
      // Skip if overlaps finder patterns
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= dimension - 8) || (ar >= dimension - 8 && ac <= 8)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const inPattern = r >= -1 && r <= 1 && c >= -1 && c <= 1;
          matrix[ar + r][ac + c] = inPattern ? (r === -1 || r === 1 || c === -1 || c === 1 || (r === 0 && c === 0)) ? 1 : 0 : 0;
        }
      }
    }
  }

  // Reserve format info area
  for (let i = 0; i <= 8; i++) if (matrix[i][8] === -1) matrix[i][8] = 0;
  for (let i = 0; i <= 8; i++) if (matrix[8][i] === -1) matrix[8][i] = 0;
  if (matrix[8][dimension - 8] === -1) matrix[8][dimension - 8] = 0;
  for (let i = dimension - 8; i < dimension; i++) if (matrix[i][8] === -1) matrix[i][8] = 0;

  // Place data
  let col = dimension - 1;
  let up = true;
  let bitIdx = 0;

  const placeBit = (r: number, c: number) => {
    if (bitIdx >= message.length * 8) return;
    if (matrix[r][c] !== -1) return;
    const byteIdx = Math.floor(bitIdx / 8);
    const bitPos = 7 - (bitIdx % 8);
    matrix[r][c] = ((message[byteIdx] >> bitPos) & 1) ^ maskPattern(r, c, 2); // Mask pattern 2
    bitIdx++;
  };

  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < dimension; i++) {
      const r = up ? dimension - 1 - i : i;
      placeBit(r, col);
      placeBit(r, col - 1);
    }
    up = !up;
    col -= 2;
  }

  // Format info (mask pattern 2, error level M - pre-computed)
  matrix[8][0] = 1; matrix[8][1] = 1; matrix[8][2] = 0; matrix[8][3] = 1;
  matrix[8][4] = 0; matrix[8][5] = 0; matrix[8][6] = 1;
  matrix[7][8] = 0; matrix[8][8] = 0; matrix[8][7] = 0;
  matrix[6][8] = 1; matrix[5][8] = 0; matrix[4][8] = 1; matrix[3][8] = 1;
  matrix[2][8] = 1; matrix[1][8] = 0; matrix[0][8] = 0;
  matrix[dimension - 1][8] = 1; matrix[dimension - 2][8] = 1; matrix[dimension - 3][8] = 0;
  matrix[dimension - 4][8] = 0; matrix[dimension - 5][8] = 0; matrix[dimension - 6][8] = 0;
  matrix[dimension - 7][8] = 0;
  matrix[8][dimension - 8] = 0; matrix[8][dimension - 7] = 0; matrix[8][dimension - 6] = 1;
  matrix[8][dimension - 5] = 1; matrix[8][dimension - 4] = 1; matrix[8][dimension - 3] = 1;
  matrix[8][dimension - 2] = 0; matrix[8][dimension - 1] = 0;

  // Render SVG
  const padding = 4;
  const totalSize = dimension + padding * 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${totalSize} ${totalSize}"><rect width="${totalSize}" height="${totalSize}" fill="white"/>`;

  for (let r = 0; r < dimension; r++) {
    for (let c = 0; c < dimension; c++) {
      if (matrix[r][c] === 1) {
        svg += `<rect x="${c + padding}" y="${r + padding}" width="1" height="1" fill="black"/>`;
      }
    }
  }

  svg += "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function maskPattern(row: number, col: number, pattern: number): number {
  switch (pattern) {
    case 0: return (row + col) % 2 === 0 ? 1 : 0;
    case 1: return row % 2 === 0 ? 1 : 0;
    case 2: return col % 3 === 0 ? 1 : 0;
    case 3: return (row + col) % 3 === 0 ? 1 : 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0 ? 1 : 0;
    case 5: return ((row * col) % 2 + (row * col) % 3) === 0 ? 1 : 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0 ? 1 : 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0 ? 1 : 0;
    default: return 0;
  }
}
