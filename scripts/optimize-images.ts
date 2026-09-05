import sharp from "sharp";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT_DIR = process.cwd();
const SRC_ASSETS_DIR = join(ROOT_DIR, "src", "assets");
const PUBLIC_DIR = join(ROOT_DIR, "public");

mkdirSync(PUBLIC_DIR, { recursive: true });
mkdirSync(SRC_ASSETS_DIR, { recursive: true });

// Pack PNG buffers into a multi-resolution ICO file
function createIco(pngBuffers: Array<{ width: number; height: number; buffer: Buffer }>): Buffer {
  const numImages = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // 1 = ICO type
  header.writeUInt16LE(numImages, 4);

  const dirEntries: Buffer[] = [];
  let currentOffset = 6 + numImages * 16;

  for (const img of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.width >= 256 ? 0 : img.width, 0);
    entry.writeUInt8(img.height >= 256 ? 0 : img.height, 1);
    entry.writeUInt8(0, 2); // Color palette
    entry.writeUInt8(0, 3); // Reserved
    entry.writeUInt16LE(1, 4); // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(img.buffer.length, 8); // Size
    entry.writeUInt32LE(currentOffset, 12); // Offset
    dirEntries.push(entry);
    currentOffset += img.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map((b) => b.buffer)]);
}

export async function optimizeFavicon(): Promise<void> {
  const faviconSource = join(SRC_ASSETS_DIR, "favicon.png");
  if (!existsSync(faviconSource)) {
    console.warn("[optimize-images] favicon.png not found in src/assets, skipping favicon optimization");
    return;
  }

  // Crop outer dead space border around the rounded icon card
  const { data, info } = await sharp(faviconSource)
    .extract({ left: 85, top: 85, width: 1084, height: 1084 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Add transparency to the black corners outside the rounded card
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 3]!;
    const g = data[i * 3 + 1]!;
    const b = data[i * 3 + 2]!;
    // Corner pixels outside rounded card are ~2, card background is ~16
    const isCorner = r <= 8 && g <= 8 && b <= 8;
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = isCorner ? 0 : 255;
  }

  const baseSharp = sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  });

  const b16 = await baseSharp.clone().resize(16, 16).png().toBuffer();
  const b32 = await baseSharp.clone().resize(32, 32).png().toBuffer();
  const b48 = await baseSharp.clone().resize(48, 48).png().toBuffer();
  const b180 = await baseSharp.clone().resize(180, 180).png().toBuffer();
  const b192 = await baseSharp.clone().resize(192, 192).png().toBuffer();
  const b512 = await baseSharp.clone().resize(512, 512).png().toBuffer();

  const icoBuffer = createIco([
    { width: 16, height: 16, buffer: b16 },
    { width: 32, height: 32, buffer: b32 },
    { width: 48, height: 48, buffer: b48 },
  ]);

  writeFileSync(join(PUBLIC_DIR, "favicon.ico"), new Uint8Array(icoBuffer));
  writeFileSync(join(PUBLIC_DIR, "favicon.png"), new Uint8Array(b32));
  writeFileSync(join(PUBLIC_DIR, "favicon-48.png"), new Uint8Array(b48));
  writeFileSync(join(PUBLIC_DIR, "apple-touch-icon.png"), new Uint8Array(b180));
  writeFileSync(join(PUBLIC_DIR, "icon-192.png"), new Uint8Array(b192));
  writeFileSync(join(PUBLIC_DIR, "icon-512.png"), new Uint8Array(b512));

  // Web manifest
  const manifest = {
    name: "VaporStats",
    short_name: "VaporStats",
    description: "Steam Analytics and Game Intelligence",
    start_url: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
  writeFileSync(join(PUBLIC_DIR, "site.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");

  console.log("[optimize-images] Favicon suite generated in public/ (ICO, PNGs, manifest)");
}

export async function optimizeLogo(): Promise<void> {
  const logoSource = join(SRC_ASSETS_DIR, "logo.png");
  if (!existsSync(logoSource)) {
    console.warn("[optimize-images] logo.png not found in src/assets, skipping logo optimization");
    return;
  }

  const { data, info } = await sharp(logoSource).raw().toBuffer({ resolveWithObject: true });

  // Detect non-black content bounding box
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const r = data[idx]!, g = data[idx + 1]!, b = data[idx + 2]!;
      if (r > 30 || g > 30 || b > 30) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const pad = 8;
  const cropLeft = Math.max(0, minX - pad);
  const cropTop = Math.max(0, minY - pad);
  const cropWidth = Math.min(info.width - cropLeft, (maxX - minX + 1) + pad * 2);
  const cropHeight = Math.min(info.height - cropTop, (maxY - minY + 1) + pad * 2);

  // Extract cropped region
  const cropped = await sharp(logoSource)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert to RGBA with anti-aliased transparency for near-black background
  const rgba = Buffer.alloc(cropped.info.width * cropped.info.height * 4);
  for (let i = 0; i < cropped.info.width * cropped.info.height; i++) {
    const r = cropped.data[i * 3]!;
    const g = cropped.data[i * 3 + 1]!;
    const b = cropped.data[i * 3 + 2]!;
    const maxVal = Math.max(r, g, b);
    let alpha = 255;
    if (maxVal <= 8) {
      alpha = 0;
    } else if (maxVal < 30) {
      alpha = Math.round(((maxVal - 8) / 22) * 255);
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = alpha;
  }

  const baseSharp = sharp(rgba, {
    raw: { width: cropped.info.width, height: cropped.info.height, channels: 4 },
  });

  // 1. Header display size: height 64px (crisp 2x retina for 32px display height)
  const headerWebp = await baseSharp.clone().resize({ height: 64 }).webp({ quality: 90 }).toBuffer();
  const headerPng = await baseSharp.clone().resize({ height: 64 }).png({ compressionLevel: 9 }).toBuffer();

  writeFileSync(join(PUBLIC_DIR, "logo.webp"), new Uint8Array(headerWebp));
  writeFileSync(join(PUBLIC_DIR, "logo.png"), new Uint8Array(headerPng));
  writeFileSync(join(SRC_ASSETS_DIR, "logo.webp"), new Uint8Array(headerWebp));

  // 2. Full resolution cropped
  const fullWebp = await baseSharp.clone().webp({ quality: 90 }).toBuffer();
  const fullPng = await baseSharp.clone().png({ compressionLevel: 9 }).toBuffer();

  writeFileSync(join(PUBLIC_DIR, "logo-full.webp"), new Uint8Array(fullWebp));
  writeFileSync(join(PUBLIC_DIR, "logo-full.png"), new Uint8Array(fullPng));

  console.log(`[optimize-images] Logo optimized: header WebP (${headerWebp.length}B), header PNG (${headerPng.length}B), full WebP (${fullWebp.length}B)`);
}

export async function optimizeAll(): Promise<void> {
  await optimizeFavicon();
  await optimizeLogo();
}

if (import.meta.main || process.argv[1]?.endsWith("optimize-images.ts")) {
  optimizeAll().catch((err) => {
    console.error("[optimize-images] Error optimizing images:", err);
    process.exit(1);
  });
}
