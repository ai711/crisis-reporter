export type ValidationResult =
  | { ok: true; file: File; width: number; height: number }
  | { ok: false; reason: string };

const HEIC_MAGIC = new Uint8Array([0x00, 0x00, 0x00]);

// ── Image loading helper ──────────────────────────────────────────────────────
// createImageBitmap is unavailable on iOS < 15 and some older Android WebViews.
// Fall back to HTMLImageElement, which is universally supported.

interface ImageSource {
  width: number;
  height: number;
  drawTo: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void;
  close: () => void;
}

async function loadImageSource(file: Blob): Promise<ImageSource> {
  if (typeof createImageBitmap !== "undefined") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        drawTo: (ctx) => ctx.drawImage(bitmap, 0, 0),
        close: () => bitmap.close(),
      };
    } catch {
      // Fall through to HTMLImageElement path
    }
  }

  // HTMLImageElement fallback for iOS < 15 / old Android WebViews
  return new Promise<ImageSource>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        drawTo: (ctx) => ctx.drawImage(img, 0, 0),
        close: () => { /* nothing to close for HTMLImageElement */ },
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image load failed"));
    };
    img.src = url;
  });
}

// ── HEIC sniffing ─────────────────────────────────────────────────────────────

async function sniffIsHeic(file: File): Promise<boolean> {
  try {
    const buf = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(buf);
    // ftyp box: bytes 4-7 are "ftyp", bytes 8-11 are brand
    const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (ftyp !== "ftyp") return false;
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand === "heic" || brand === "heis" || brand === "hevc" || brand === "mif1";
  } catch {
    return false;
  }
}

// ── Canvas conversion (for BMP/TIFF) ─────────────────────────────────────────

async function convertToJpegViaCanvas(file: Blob): Promise<File> {
  const source = await loadImageSource(file);
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (ctx) source.drawTo(ctx);
  source.close();
  return new Promise<File>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("canvas toBlob returned null")); return; }
        resolve(new File([blob], "converted.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92
    );
  });
}

// ── Duplicate detection ───────────────────────────────────────────────────────

function compositeKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

// ── Main validation ───────────────────────────────────────────────────────────

export async function validatePhoto(
  file: File,
  existingPhotos: File[]
): Promise<ValidationResult> {
  // C9 — empty file
  if (file.size === 0) {
    return { ok: false, reason: "This photo appears to be empty. Please select a different file." };
  }

  // C1–C8 — format detection and conversion
  const mime = file.type.toLowerCase();
  let workingFile: File;

  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") {
    workingFile = file;
  } else if (
    mime === "image/heic" ||
    mime === "image/heif" ||
    ((mime === "" || mime === "application/octet-stream") && (await sniffIsHeic(file)))
  ) {
    try {
      // heic2any is a default import; use dynamic import to avoid bundler issues
      const heic2any = (await import("heic2any")).default;
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      const resultBlob = Array.isArray(converted) ? converted[0] : converted;
      workingFile = new File([resultBlob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
    } catch {
      return { ok: false, reason: "This file type cannot be used. Please select a JPG, PNG, or similar image file." };
    }
  } else if (mime === "image/bmp" || mime === "image/tiff") {
    try {
      workingFile = await convertToJpegViaCanvas(file);
    } catch {
      return { ok: false, reason: "This file type cannot be used. Please select a JPG, PNG, or similar image file." };
    }
  } else if (mime === "image/gif") {
    return { ok: false, reason: "Animated or GIF files cannot be used. Please select a standard photo." };
  } else if (mime.startsWith("image/")) {
    return { ok: false, reason: "This file type cannot be used. Please select a JPG, PNG, or similar image file." };
  } else {
    return { ok: false, reason: "This file type cannot be used. Please select a JPG, PNG, or similar image file." };
  }

  // C10 — corruption check
  let source: ImageSource;
  try {
    source = await loadImageSource(workingFile);
  } catch {
    return { ok: false, reason: "This photo could not be read. It may be corrupted. Please try a different photo." };
  }

  // C11 — minimum dimension check
  if (source.width < 100 || source.height < 100) {
    source.close();
    return { ok: false, reason: "This photo is too small. Please select a clearer, larger image." };
  }

  // C12 — blank (all-black / all-white) check via pixel sampling
  try {
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(source.width, source.height);
      ctx = (canvas as OffscreenCanvas).getContext("2d");
    } else {
      canvas = document.createElement("canvas");
      (canvas as HTMLCanvasElement).width = source.width;
      (canvas as HTMLCanvasElement).height = source.height;
      ctx = (canvas as HTMLCanvasElement).getContext("2d");
    }

    if (ctx) {
      source.drawTo(ctx);
      const imageData = ctx.getImageData(0, 0, source.width, source.height);
      const data = imageData.data;
      let blankCount = 0;
      let totalSampled = 0;
      const stride = 20;

      for (let y = 0; y < source.height; y += stride) {
        for (let x = 0; x < source.width; x += stride) {
          const i = (y * source.width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const isBlack = r < 10 && g < 10 && b < 10;
          const isWhite = r > 245 && g > 245 && b > 245;
          if (isBlack || isWhite) blankCount++;
          totalSampled++;
        }
      }

      if (totalSampled > 0 && blankCount / totalSampled >= 0.95) {
        source.close();
        return { ok: false, reason: "This photo appears to be blank. Please take or select a photo that shows the damage." };
      }
    }
  } catch {
    // Non-critical — if pixel sampling fails, let the photo through
  }

  const { width, height } = source;
  source.close();

  // C13 — duplicate check
  const incomingKey = compositeKey(file);
  for (const existing of existingPhotos) {
    if (compositeKey(existing) === incomingKey) {
      return { ok: false, reason: "This photo has already been added." };
    }
  }

  return { ok: true, file: workingFile, width, height };
}

// Suppress unused variable warning for HEIC_MAGIC (used as import guard pattern)
void HEIC_MAGIC;
