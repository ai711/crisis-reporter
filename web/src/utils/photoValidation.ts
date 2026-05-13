export type ValidationResult =
  | { ok: true; file: File; width: number; height: number }
  | { ok: false; reason: string };

const HEIC_MAGIC = new Uint8Array([0x00, 0x00, 0x00]);

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

async function convertToJpegViaCanvas(file: Blob): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
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

function compositeKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

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
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(workingFile);
  } catch {
    return { ok: false, reason: "This photo could not be read. It may be corrupted. Please try a different photo." };
  }

  // C11 — minimum dimension check
  if (bitmap.width < 100 || bitmap.height < 100) {
    bitmap.close();
    return { ok: false, reason: "This photo is too small. Please select a clearer, larger image." };
  }

  // C12 — blank (all-black / all-white) check via pixel sampling
  try {
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      ctx = (canvas as OffscreenCanvas).getContext("2d");
    } else {
      canvas = document.createElement("canvas");
      (canvas as HTMLCanvasElement).width = bitmap.width;
      (canvas as HTMLCanvasElement).height = bitmap.height;
      ctx = (canvas as HTMLCanvasElement).getContext("2d");
    }

    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const data = imageData.data;
      let blankCount = 0;
      let totalSampled = 0;
      const stride = 20;

      for (let y = 0; y < bitmap.height; y += stride) {
        for (let x = 0; x < bitmap.width; x += stride) {
          const i = (y * bitmap.width + x) * 4;
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
        bitmap.close();
        return { ok: false, reason: "This photo appears to be blank. Please take or select a photo that shows the damage." };
      }
    }
  } catch {
    // Non-critical — if pixel sampling fails, let the photo through
  }

  const { width, height } = bitmap;
  bitmap.close();

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
