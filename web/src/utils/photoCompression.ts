export interface CompressionResult {
  file: File;
  compressed: boolean;
  original_size_kb: number;
  compressed_size_kb: number;
}

// ── Image loading helper ──────────────────────────────────────────────────────
// createImageBitmap is unavailable on iOS < 15 and some older Android WebViews.
// Fall back to HTMLImageElement, which is universally supported.

interface ImageSource {
  width: number;
  height: number;
  drawTo: (ctx: CanvasRenderingContext2D) => void;
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

// ── Compression ───────────────────────────────────────────────────────────────

export async function compressPhoto(file: File): Promise<CompressionResult> {
  const original_size_kb = Math.round(file.size / 1024);

  // Under 1.5 MB — send as-is
  if (file.size < 1.5 * 1024 * 1024) {
    return { file, compressed: false, original_size_kb, compressed_size_kb: original_size_kb };
  }

  // Target: ~1 MB for 1.5–8 MB files, ~1.5 MB for files above 8 MB
  const targetQuality = 0.82;

  try {
    const source = await loadImageSource(file);
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d")!;
    source.drawTo(ctx);
    source.close();

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
        "image/jpeg",
        targetQuality
      );
    });

    const compressed_size_kb = Math.round(blob.size / 1024);
    const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
      type: "image/jpeg",
    });

    return { file: compressedFile, compressed: true, original_size_kb, compressed_size_kb };
  } catch {
    // Compression failed — send original rather than blocking the reporter
    return { file, compressed: false, original_size_kb, compressed_size_kb: original_size_kb };
  }
}
